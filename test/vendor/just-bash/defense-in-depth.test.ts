// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The defense-in-depth box on real Bun, as every bash command runs under
// it: require() and require.resolve are blocked inside a command and a
// reassignment of Module._resolveFilename too, on the main thread and in
// a Worker, with no patch failed once the box is on; the worker's own box
// blocks them and code from strings; trusted host work that settles
// after a cancel still reaches its caller; a lazy file's provider runs
// trusted while an untrusted command after it stays blocked; timeout on a
// command still loading ends only that command. Each case runs in its own
// bun process, since the box patches process globals and the tests of a
// file run concurrently.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../../vendor/just-bash/src");
const BOX = join(SRC, "security/defense-in-depth-box.ts");
const WORKER_BOX = join(SRC, "security/worker-defense-in-depth.ts");
const INDEX = join(SRC, "index.ts");

async function runBun(script: string): Promise<string> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`bun exited ${code}: ${stderr}`);
  return stdout.trim();
}

// a script run in a Worker, printing what it posts back
const inWorker = (body: string) => `
  const url = URL.createObjectURL(
    new Blob([${JSON.stringify(body)}], { type: "text/javascript" }),
  );
  const worker = new Worker(url);
  worker.onmessage = (event) => {
    console.log(event.data);
    worker.terminate();
  };
  worker.onerror = (event) => {
    console.log(JSON.stringify({ error: event.message }));
    worker.terminate();
  };
`;

// the guard's probe, the same on the main thread and in a Worker; it
// reports each attempt as ok or the violation it raised
const GUARD = `
  const { DefenseInDepthBox } = await import(${JSON.stringify(BOX)});
  const { Module } = require("node:module");
  const attempt = (fn) => {
    try { fn(); return "ok"; }
    catch (error) { return error.violation?.type ?? "error"; }
  };
  const box = DefenseInDepthBox.getInstance(true);
  const out = {};
  // the patches go on at activation, so their failures are read after it
  const handle = box.activate();
  out.failures = box.getPatchFailures();
  await handle.run(async () => {
    out.require = attempt(() => require("child_process"));
    out.resolve = attempt(() => require.resolve("node:path"));
    out.assign = attempt(() => { Module._resolveFilename = () => "x"; });
  });
  handle.deactivate();
  out.requireAfter = attempt(() => require("child_process"));
  out.resolveAfter = attempt(() => require.resolve("node:path"));
`;

const BLOCKED = {
  failures: [],
  require: "module_resolve_filename",
  resolve: "module_resolve_filename",
  assign: "module_resolve_filename",
  requireAfter: "ok",
  resolveAfter: "ok",
};

describe("the defense-in-depth box on bun", () => {
  test("blocks require inside a command on the main thread", async () => {
    const out = await runBun(`${GUARD}\nconsole.log(JSON.stringify(out));`);
    expect(JSON.parse(out)).toEqual(BLOCKED);
  }, 20_000);

  test("blocks require inside a command in a worker", async () => {
    const body = `${GUARD}\npostMessage(JSON.stringify(out));`;
    const out = await runBun(inWorker(body));
    expect(JSON.parse(out)).toEqual(BLOCKED);
  }, 20_000);

  // the worker's own box, which patches the whole worker at once, with
  // every patch in place
  test("the worker box blocks require and code from strings in a worker", async () => {
    const body = `
      const { WorkerDefenseInDepth } = await import(${JSON.stringify(WORKER_BOX)});
      const attempt = (fn) => {
        try { fn(); return "ok"; }
        catch (error) { return error.violation?.type ?? "error"; }
      };
      const box = new WorkerDefenseInDepth({ enabled: true });
      const out = {
        active: box.getStats().isActive,
        failures: box.patchFailures,
        require: attempt(() => require("child_process")),
        resolve: attempt(() => require.resolve("node:path")),
        code: attempt(() => new Function("return 1")),
      };
      box.deactivate();
      out.codeAfter = attempt(() => new Function("return 1"));
      postMessage(JSON.stringify(out));
    `;
    const out = JSON.parse(await runBun(inWorker(body)));
    expect(out).toMatchObject({ active: true, failures: [], codeAfter: "ok" });
    expect(out.require).not.toBe("ok");
    expect(out.resolve).not.toBe("ok");
    expect(out.code).not.toBe("ok");
  }, 20_000);

  // host work the command awaits, settled only after the command was
  // cancelled and its box deactivated
  const late = (settle: string) => `
    const { DefenseInDepthBox } = await import(${JSON.stringify(BOX)});
    const unhandled = [];
    process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));
    let resolve, reject;
    const pending = new Promise((res, rej) => { resolve = res; reject = rej; });
    const handle = DefenseInDepthBox.getInstance(true).activate();
    let outcome = "none";
    await handle.run(async () => {
      void (async () => {
        try {
          outcome = "value " + (await DefenseInDepthBox.runTrustedAsync(() => pending));
        } catch (error) {
          outcome = "caught " + error.message;
        }
      })();
    });
    handle.deactivate();
    ${settle};
    await new Promise((done) => setTimeout(done, 50));
    console.log(JSON.stringify({ outcome, unhandled }));
  `;

  test("hands a late rejection of trusted work to its caller", async () => {
    const out = await runBun(late(`reject(new Error("late"))`));
    expect(JSON.parse(out)).toEqual({ outcome: "caught late", unhandled: [] });
  }, 20_000);

  test("hands a late value of trusted work to its caller", async () => {
    const out = await runBun(late(`resolve("late")`));
    expect(JSON.parse(out)).toEqual({ outcome: "value late", unhandled: [] });
  }, 20_000);

  // a kept MCP file is a lazy file whose provider asks the server, and open
  // is an untrusted command that may run right after it is read
  test("a lazy file settles on a macrotask and an untrusted command stays blocked", async () => {
    const out = await runBun(`
      const { Bash, InMemoryFs, defineCommand } = await import(${JSON.stringify(INDEX)});
      const probe = defineCommand(
        "probe",
        async () => {
          try {
            new Function("return 1");
            return { stdout: "unblocked\\n", stderr: "", exitCode: 0 };
          } catch (error) {
            return { stdout: (error.violation?.type ?? "error") + "\\n", stderr: "", exitCode: 0 };
          }
        },
        { trusted: false },
      );
      const fs = new InMemoryFs();
      fs.writeFileLazy("/late.md", async () => {
        await new Promise((done) => setTimeout(done, 5));
        return "LATE\\n";
      });
      const bash = new Bash({ defenseInDepth: true, fs, customCommands: [probe] });
      const result = await bash.exec("cat /late.md && probe");
      console.log(JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }));
      process.exit(0);
    `);
    expect(JSON.parse(out)).toEqual({
      stdout: "LATE\nfunction_constructor\n",
      stderr: "",
      exitCode: 0,
    });
  }, 20_000);

  test("timeout on a command still loading ends only that command", async () => {
    const out = await runBun(`
      const { Bash } = await import(${JSON.stringify(INDEX)});
      const bash = new Bash({
        defenseInDepth: true,
        customCommands: [
          { name: "pending-import", load: () => new Promise(() => {}) },
        ],
      });
      const result = await bash.exec(
        'timeout 0.01 pending-import\\necho "EXIT=$?"\\necho AFTER\\n',
      );
      console.log(JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }));
      process.exit(0);
    `);
    expect(JSON.parse(out)).toEqual({
      stdout: "EXIT=124\nAFTER\n",
      stderr: "",
      exitCode: 0,
    });
  }, 20_000);
});
