// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The bench target: a clone of a built database (an APFS clone, so it
// costs nothing until written), fenced onto the fakes with a password
// of this run's own, the fake model and the fake MCP, the server from a
// checkout, N turns with watchers and the probe for a while, then all
// stopped. The logs land in out/results/<label>/ and the results row is
// printed.
//
//   bun scripts/load/bench.ts [--db PATH] [--checkout PATH] [--n 10]
//     [--seconds 120] [--shape day|bash|text|markdown] [--repeat 1]
//     [--label NAME] [--port 1240] [--tool-share 0.25]
//   bun scripts/load/bench.ts --smoke    (a tiny build, N=2 for 30 s)

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { build, defaultDb, OUT_DIR } from "./db/build.ts";
import { SHAPES, type Shape } from "./fake-model.ts";
import { fence, fenced } from "./fence.ts";
import { FAKE, fakeMcpUrl, fakeModelUrl } from "./shapes.ts";
import { printTable, summarize } from "./summarize.ts";

const ROOT = resolve(import.meta.dir, "../..");
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const smoke = argv.includes("--smoke");

const sleep = (ms: number) => Bun.sleep(ms);
const up = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};
async function waitUp(url: string, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await up(url)) return;
    await sleep(500);
  }
  throw new Error(`${what} did not come up at ${url}`);
}

function clone(from: string, to: string) {
  for (const f of [to, `${to}-wal`, `${to}-shm`])
    if (existsSync(f)) unlinkSync(f);
  const wal = `${from}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new Error(
      `${from} has a write-ahead log: checkpoint it before a run`,
    );
  }
  // a copy-on-write clone where the file system has one
  const args = process.platform === "darwin" ? ["-c"] : ["--reflink=auto"];
  const cp = Bun.spawnSync(["cp", ...args, from, to]);
  if (cp.exitCode !== 0) throw new Error(`cp: ${cp.stderr.toString()}`);
}

async function main() {
  const shape = (flag("shape") ?? "day") as Shape;
  if (!SHAPES.includes(shape))
    throw new Error(`--shape is one of ${SHAPES.join(", ")}`);
  const n = Number(flag("n") ?? (smoke ? 2 : 10));
  const seconds = Number(flag("seconds") ?? (smoke ? 30 : 120));
  const label = flag("label") ?? (smoke ? "smoke" : `local-${shape}-n${n}`);
  const port = Number(flag("port") ?? 1240);
  const checkout = resolve(flag("checkout") ?? ROOT);
  let db = resolve(flag("db") ?? defaultDb(smoke ? "tiny" : "bench"));
  if (smoke && !existsSync(db)) await build({ preset: "tiny", out: db });
  if (!existsSync(db)) {
    throw new Error(
      `no database at ${db}: build one with make load-db PRESET=bench`,
    );
  }
  if (!existsSync(join(checkout, "src/server/main.ts"))) {
    throw new Error(`${checkout} is not a 1ctx checkout`);
  }
  const base = `http://127.0.0.1:${port}`;
  const modelUrl = fakeModelUrl();
  for (const url of [
    `${base}/api/health`,
    `http://127.0.0.1:${FAKE.modelPort}/health`,
    `http://127.0.0.1:${FAKE.mcpPort}/health`,
  ]) {
    if (await up(url)) throw new Error(`${url} already answers: stop it first`);
  }
  const results = join(OUT_DIR, "results", label);
  const run = join(OUT_DIR, "run");
  mkdirSync(results, { recursive: true });
  mkdirSync(join(run, "secrets"), { recursive: true });
  const runDb = join(run, "run.sqlite");
  clone(db, runDb);
  db = runDb;

  // the fence, and one throwaway password for every user of this run
  const password = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("hex");
  const hash = await Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 2,
  });
  const handle = new Database(db);
  const fenceOptions = {
    modelUrl,
    mcpUrl: (s: string) => fakeMcpUrl(s),
    passwordHash: hash,
  };
  const report = fence(handle, fenceOptions);
  const wrong = fenced(handle, fenceOptions);
  const admin = handle
    .query<{ username: string }, []>(
      "select username from users where role = 'admin' and disabled = 0 order by username limit 1",
    )
    .get()?.username;
  handle.close();
  if (wrong.length > 0)
    throw new Error(`the fence failed: ${wrong.join(", ")}`);
  if (admin === undefined) throw new Error("the database has no admin");

  const log = (name: string) => Bun.file(join(results, `${name}.log`));
  const commit = Bun.spawnSync([
    "git",
    "-C",
    checkout,
    "rev-parse",
    "--short",
    "HEAD",
  ])
    .stdout.toString()
    .trim();
  await Bun.write(
    join(results, "meta.json"),
    `${JSON.stringify({ target: "bench", label, db: flag("db") ?? defaultDb(smoke ? "tiny" : "bench"), checkout, commit, shape, n, seconds, fence: report, at: new Date().toISOString() }, null, 2)}\n`,
  );

  const procs: Bun.Subprocess[] = [];
  const spawn = (
    cmd: string[],
    name: string,
    env: Record<string, string> = {},
    cwd = ROOT,
  ) => {
    const p = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, ...env },
      stdout: log(name),
      stderr: log(`${name}-err`),
    });
    procs.push(p);
    return p;
  };
  try {
    spawn(["bun", "scripts/load/fake-model.ts"], "model", {
      SHAPE: shape,
      REPEAT: flag("repeat") ?? "1",
    });
    spawn(["bun", "scripts/load/fake-mcp.ts"], "mcp");
    await waitUp(`http://127.0.0.1:${FAKE.modelPort}/health`, "the fake model");
    await waitUp(`http://127.0.0.1:${FAKE.mcpPort}/health`, "the fake MCP");
    const server = Bun.spawn(
      [
        "bun",
        "src/server/main.ts",
        "--listen",
        `127.0.0.1:${port}`,
        "--db",
        db,
        "--secrets",
        join(run, "secrets"),
        "--trust-proxy",
        "--drain",
        "0",
      ],
      { cwd: checkout, stdout: log("server-out"), stderr: log("server") },
    );
    procs.push(server);
    await waitUp(`${base}/api/health`, "the server");

    // CPU and memory of the server, and the WAL, every 5 s
    const top: string[] = [];
    const sampler = setInterval(() => {
      const ps = Bun.spawnSync([
        "ps",
        "-o",
        "%cpu=,rss=",
        "-p",
        String(server.pid),
      ])
        .stdout.toString()
        .trim()
        .split(/\s+/);
      const wal = existsSync(`${db}-wal`) ? statSync(`${db}-wal`).size : 0;
      top.push(
        JSON.stringify({
          t: "top",
          at: Date.now(),
          cpuM: Math.round(Number(ps[0]) * 10),
          memMi: Math.round(Number(ps[1]) / 1024),
          walMb: +(wal / 2 ** 20).toFixed(1),
        }),
      );
    }, 5000);
    const driver = spawn(
      [
        "bun",
        "scripts/load/driver/main.ts",
        "turns",
        String(n),
        String(seconds),
        "--tool-share",
        flag("tool-share") ?? "0.25",
      ],
      "driver",
      {
        BASE: base,
        ADMIN: admin,
        PASSWORD: password,
        FAKE_MODEL_URL: modelUrl,
        FAKE_MCP_URL: `http://127.0.0.1:${FAKE.mcpPort}/`,
      },
    );
    const code = await driver.exited;
    clearInterval(sampler);
    await Bun.write(join(results, "top.log"), `${top.join("\n")}\n`);
    if (code !== 0)
      console.error(
        `the driver exited ${code}: see ${join(results, "driver.log")}`,
      );
  } finally {
    for (const p of procs.reverse()) p.kill("SIGTERM");
    await Promise.all(procs.map((p) => p.exited));
  }
  printTable([await summarize(results)]);
}

await main();
