// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Drives a real OpenShell gateway through the sandbox backend, by hand
// (make sandbox-check ARGS="..."), for what the fake gateway cannot
// show: the push, the walk and pull, the fence against real processes,
// open, the cwd, a read-only repository, the recycles and the timings.
// The rows live in memory here, committed as mount.ts would. Every
// sandbox it makes carries a fresh instance label and is deleted
// through the gateway at the end; no other sandbox is touched.
//
//   bun scripts/sandbox-check.ts --endpoint https://127.0.0.1:17670 \
//     --ca ca.crt --cert tls.crt --key tls.key [--variant python] \
//     [--image 1ctx-shell:dev-<variant>] \
//     [--repo-dir <a folder Docker Desktop shares>]
//
// The repository is a fresh folder made under --repo-dir (the system's
// temporary folder by default) and removed at the end; nothing else
// there is written.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type {
  Answer,
  Job,
  Mounted,
  SettleOutcome,
  ShellCall,
  ShellRepo,
} from "../src/server/bash/index.ts";
import { wallClock } from "../src/server/lib/clock.ts";
import { logger } from "../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../src/server/limits/index.ts";
import { sandboxBackend } from "../src/server/sandbox/backend.ts";
import { HELPER_SOURCES } from "../src/server/sandbox/helpers.ts";
import {
  type Gateway,
  INSTANCE_LABEL,
  Leases,
  openshellGateway,
  type SandboxHold,
} from "../src/server/sandbox/index.ts";
import {
  isSandboxVariant,
  type SandboxVariant,
} from "../src/shared/contracts/sandbox.ts";

const { values: flags } = parseArgs({
  options: {
    endpoint: { type: "string", default: "https://127.0.0.1:17670" },
    ca: { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    variant: { type: "string", default: "python" },
    image: { type: "string" },
    "repo-dir": { type: "string" },
  },
});
if (
  !flags.ca ||
  !flags.cert ||
  !flags.key ||
  !isSandboxVariant(flags.variant)
) {
  console.error(
    "usage: --ca <pem> --cert <pem> --key <pem> [--endpoint] [--variant python|bun|go|rust] [--image] [--repo-dir]",
  );
  process.exit(2);
}
const variant: SandboxVariant = flags.variant;

const encoder = new TextEncoder();
const instanceId = Array.from(
  crypto.getRandomValues(new Uint8Array(12)),
  (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
).join("");
// small caps, so a first push and a walk are quick to read
const limits = {
  ...DEFAULT_LIMITS,
  knowledgeProjectBytes: 4 << 20,
  scratchBytes: 4 << 20,
  uploadBytes: 4 << 20,
  mcpKeptBytes: 4 << 20,
};

// every exec timed by which helper it ran
const timings: { step: string; ms: number }[] = [];
const stepOf = (command: string[]) => {
  const source = command[4];
  for (const [name, text] of Object.entries(HELPER_SOURCES))
    if (source === text) return name === "wrapper" ? "command" : name;
  return command[0] === "/usr/bin/find" ? "records" : "other";
};
const real = openshellGateway({
  endpoint: flags.endpoint!,
  ca: readFileSync(flags.ca, "utf8"),
  cert: readFileSync(flags.cert, "utf8"),
  key: readFileSync(flags.key, "utf8"),
});
const gateway: Gateway = {
  ...real,
  exec(request) {
    const step = stepOf(request.command);
    const started = performance.now();
    const events = real.exec(request);
    return (async function* () {
      try {
        yield* events;
      } finally {
        timings.push({ step, ms: Math.round(performance.now() - started) });
      }
    })();
  },
};
const log = logger("sandbox-check");
const leases = new Leases({
  clock: wallClock,
  log,
  gateway,
  instanceId,
  image: flags.image ?? `1ctx-shell:dev-${variant}`,
  limits: () => limits,
  repos: { hold: () => () => {} },
});
const backend = sandboxBackend({ clock: wallClock, log, limits: () => limits });

// the rows of one workspace, as the database would hold them
type Rows = {
  workspace: string;
  repos: ShellRepo[];
  docs: Map<
    string,
    { id: string; revision: number; updatedAt: number; text: string }
  >;
  scratch: Map<string, { data: Uint8Array; mode: number }>;
  revision: number;
  usedAt: number | null;
  cwd: string;
  uploads: Record<string, string>;
  kept: Record<string, string>;
};

function rows(workspace: string, repos: ShellRepo[] = []): Rows {
  const now = Date.now();
  return {
    workspace,
    repos,
    docs: new Map([
      [
        "a.md",
        { id: "doc-a", revision: 1, updatedAt: now, text: "# A\nhello\n" },
      ],
      ["notes/b.md", { id: "doc-b", revision: 1, updatedAt: now, text: "b\n" }],
    ]),
    scratch: new Map([
      ["notes.txt", { data: encoder.encode("x"), mode: 0o644 }],
    ]),
    revision: 1,
    usedAt: now,
    cwd: "/knowledge",
    uploads: { "in/data.csv": "1,2\n" },
    kept: { "/mcp/0001-read/result.txt": "kept\n" },
  };
}

const callOf = (r: Rows): ShellCall => ({
  projectId: "check",
  workspace: { id: r.workspace, sessionId: r.workspace },
  root: r.workspace,
  sendId: "check",
  subagent: false,
  repos: r.repos,
  repoFileBytes: 1 << 20,
  network: false,
  credentials: [],
});

function jobOf(
  r: Rows,
  command: string,
  timeoutMs: number,
): { job: Job; mounted: Mounted } {
  const docs = [...r.docs];
  return {
    job: {
      command,
      endsAt: Date.now() + timeoutMs,
      docs: true,
      visuals: true,
      network: false,
      cwd: r.cwd,
      knowledgeFileBytes: limits.knowledgeFileBytes,
      mountBytes: 64 << 20,
      ioBytes: 1 << 20,
      resultCut: 50_000,
      iterations: 10_000,
      knowledge: docs.map(([name, doc]) => ({
        name,
        data: encoder.encode(doc.text),
        mtime: doc.updatedAt,
      })),
      scratch: [...r.scratch].map(([name, file]) => ({
        name,
        ...file,
        mtime: r.usedAt ?? 0,
      })),
      uploads: Object.entries(r.uploads).map(([name, text]) => ({
        name,
        data: encoder.encode(text),
        mtime: 1,
      })),
      kept: Object.keys(r.kept),
      repos: r.repos.map((repo) => ({
        name: repo.name,
        folder: repo.tree,
        files: 1,
        dirs: 1,
        bytes: 1,
      })),
      repoFileBytes: 1 << 20,
    },
    mounted: {
      docs: docs.map(([name, doc]) => ({
        id: doc.id,
        name,
        revision: doc.revision,
        updatedAt: doc.updatedAt,
      })),
      scratch: { revision: r.revision, usedAt: r.usedAt },
      uploads: { sessionId: r.workspace, revision: 1 },
      kept: Object.entries(r.kept).map(([path, text], position) => ({
        messageId: "m",
        position,
        path,
        bytes: text.length,
      })),
    },
  };
}

// the commit, in memory: what mount.ts would write, then its Landed
function commit(r: Rows, answer: Answer): SettleOutcome {
  const now = Date.now();
  const changes = answer.changes!;
  const docs = changes.knowledge.map((change) => {
    const before = r.docs.get(change.name);
    const id = before?.id ?? `doc-${change.name}`;
    const revision = (before?.revision ?? 0) + 1;
    if (change.text === null) r.docs.delete(change.name);
    else
      r.docs.set(change.name, {
        id,
        revision,
        updatedAt: now,
        text: change.text,
      });
    return {
      name: change.name,
      id,
      revision,
      updatedAt: now,
      text: change.text,
    };
  });
  for (const name of changes.removed) r.scratch.delete(name);
  for (const file of changes.written)
    r.scratch.set(file.path, { data: file.data, mode: file.mode });
  r.revision++;
  r.usedAt = now;
  r.cwd = changes.cwd;
  return { landed: true, docs, scratch: { revision: r.revision, usedAt: now } };
}

// what each command did with its process slot, as mount.ts lends it
const slots: string[] = [];

async function command(r: Rows, text: string, timeoutMs = 30_000) {
  timings.length = 0;
  slots.length = 0;
  const started = performance.now();
  const hold = (await leases.acquire(
    callOf(r),
    Date.now() + timeoutMs,
    new AbortController().signal,
  )) as SandboxHold;
  const acquired = Math.round(performance.now() - started);
  const { job, mounted } = jobOf(r, text, timeoutMs);
  const ran = await backend.run(
    job,
    { ...callOf(r), mounted, hold },
    {
      kept: (index) => encoder.encode(Object.values(r.kept)[index]!),
      fetch: null,
      slot: {
        free: () => slots.push(`free ${timings.length}`),
        take: async () => {
          slots.push(`take ${timings.length}`);
        },
      },
    },
    {
      signal: new AbortController().signal,
      deadline: new AbortController().signal,
      chat: r.workspace,
    },
  );
  const settled = ran.settled;
  const answer = settled.ok ? settled.answer : null;
  // as mount.ts settles a shell whose exits are the command's own: a
  // stop or a refusal saves nothing, any exit code commits
  const commits =
    answer !== null &&
    answer.changes !== null &&
    answer.refused === null &&
    answer.stopped === undefined;
  ran.settle(commits ? commit(r, answer) : { landed: false, why: "skipped" });
  await backend.idle();
  const total = Math.round(performance.now() - started);
  const state =
    leases.rows().find((row) => row.sandbox === hold.sandbox)?.state ?? "gone";
  return {
    settled,
    answer,
    hold,
    acquired,
    total,
    state,
    steps: [...timings],
    slots: [...slots],
  };
}

const results: { step: string; ok: boolean; detail: string }[] = [];
function report(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
}
const brief = (text: string) =>
  text.trim().replaceAll("\n", " | ").slice(0, 300);
const stepsOf = (steps: { step: string; ms: number }[]) =>
  steps.map((s) => `${s.step} ${s.ms}ms`).join(", ");

async function main() {
  const chat = rows("check-chat");

  const first = await command(
    chat,
    "ls -la /knowledge /tmp /uploads /mcp/0001-read; echo HOME=$HOME TMPDIR=$TMPDIR; id -u",
  );
  report(
    "first push and listing",
    first.answer?.exitCode === 0 && first.state === "idle",
    `sandbox ${first.hold.sandbox}, acquire ${first.acquired}ms, total ${first.total}ms, ${stepsOf(first.steps)}; ${brief(first.answer?.stdout ?? String(first.settled.ok || first.settled.error?.message))}`,
  );

  const write = await command(
    chat,
    "echo hi > /knowledge/new.md; mkdir -p /tmp/d; printf x > /tmp/d/x.txt; chmod 600 /tmp/d/x.txt; ln -s / /tmp/d/link; cd /tmp/d",
  );
  report(
    "a command writes /knowledge and /tmp, saves the doc and the cwd, no scratch",
    JSON.stringify(write.answer?.changes?.knowledge) ===
      '[{"name":"new.md","text":"hi\\n"}]' &&
      write.answer?.changes?.written.length === 0 &&
      write.answer?.changes?.removed.length === 0 &&
      write.answer?.changes?.cwd === "/tmp/d" &&
      write.state === "idle",
    `changes ${JSON.stringify({ ...write.answer?.changes, written: write.answer?.changes?.written.length })}; ${stepsOf(write.steps)}`,
  );

  const after = await command(
    chat,
    "pwd; stat -c '%n %a' /tmp/d/x.txt /knowledge/new.md; ls /tmp/notes.txt 2>&1; df -h /tmp $HOME | tail -n +2",
  );
  report(
    "the next command starts in the cwd, /tmp kept as left and never pushed",
    after.answer?.stdout.startsWith("/tmp/d\n") === true &&
      after.answer.stdout.includes("/tmp/d/x.txt 600") &&
      after.answer.stdout.includes("No such file"),
    brief(after.answer?.stdout ?? ""),
  );

  const opened = await command(
    chat,
    "open /knowledge/a.md && open /knowledge/a.md && open /etc/passwd; true",
  );
  report(
    "open copies a file once and refuses outside the trees",
    opened.answer?.opened.length === 1 &&
      opened.answer.opened[0]?.path === "/knowledge/a.md" &&
      /not in the mount/.test(opened.answer.stderr),
    `opened ${JSON.stringify(opened.answer?.opened.map((o) => [o.path, o.kind, o.lines]))}; stderr ${brief(opened.answer?.stderr ?? "")}`,
  );

  const leftover = await command(
    chat,
    "setsid sleep 1000 </dev/null >/dev/null 2>&1 & disown; echo started",
  );
  const check1 = await command(
    chat,
    `for p in /proc/[0-9]*; do printf '%s ' "$(tr '\\n' '?' < $p/comm)"; done`,
  );
  report(
    "a setsid leftover is killed by the fence",
    leftover.state === "idle" &&
      (check1.answer?.stdout ?? "")
        .split(" ")
        .filter((name) => name.replace(/\?$/, "") === "sleep").length === 1,
    `exit ${leftover.answer?.exitCode}, ${leftover.total}ms, ${leftover.state}, ${stepsOf(leftover.steps)}; after: ${brief(check1.answer?.stdout ?? "")}`,
  );

  const renamed = await command(
    chat,
    `/usr/local/bin/python3 -c "import ctypes,os,time
libc=ctypes.CDLL(None)
if os.fork()==0:
  n=os.open('/dev/null', os.O_RDWR)
  for fd in (0, 1, 2): os.dup2(n, fd)
  os.setsid(); libc.prctl(15, b'evil\\nname', 0, 0, 0); time.sleep(1000)
print('forked')"`,
  );
  const check2 = await command(
    chat,
    `for p in /proc/[0-9]*; do printf '%s ' "$(tr '\\n' '?' < $p/comm)"; done`,
  );
  report(
    "a leftover renamed with a newline in its name is killed",
    renamed.state === "idle" && !(check2.answer?.stdout ?? "").includes("evil"),
    `exit ${renamed.answer?.exitCode}, ${renamed.total}ms, ${renamed.state}, ${stepsOf(renamed.steps)}; ${brief(renamed.answer?.stdout ?? "")}; after: ${brief(check2.answer?.stdout ?? "")}`,
  );

  // a background process that keeps the exec's stdout open holds the
  // command until its deadline, as the gateway waits for the stream
  const piped = rows("check-piped");
  const holding = await command(piped, "sleep 1000 & echo started", 4000);
  report(
    "a background process holding stdout runs the command to its deadline",
    holding.answer?.exitCode === 124 && holding.state !== "idle",
    `exit ${holding.answer?.exitCode}, ${holding.total}ms, ${holding.state}`,
  );

  const pid = renamed.hold.keepAlivePid;
  const ptrace = await command(
    chat,
    `/usr/local/bin/python3 -c "import ctypes,os
libc=ctypes.CDLL(None, use_errno=True)
r=libc.ptrace(16, ${pid}, 0, 0)
print('attach', r, os.strerror(ctypes.get_errno()))
try:
  open('/proc/${pid}/mem','rb').read(1); print('mem read')
except Exception as e: print('mem', type(e).__name__)"`,
  );
  report(
    "ptrace of the keep-alive is refused inside the sandbox",
    /attach -1/.test(ptrace.answer?.stdout ?? "") &&
      !/mem read/.test(ptrace.answer?.stdout ?? ""),
    brief((ptrace.answer?.stdout ?? "") + (ptrace.answer?.stderr ?? "")),
  );

  const ptmx = await command(
    chat,
    `/usr/local/bin/python3 -c "import os; os.close(os.open('/dev/ptmx', os.O_RDWR)); print('ptmx ok')"`,
  );
  report(
    "/dev/ptmx opens, as the fence's wait needs",
    (ptmx.answer?.stdout ?? "").includes("ptmx ok"),
    `${brief((ptmx.answer?.stdout ?? "") + (ptmx.answer?.stderr ?? ""))}; fence ${ptmx.steps.find((s) => s.step === "fence")?.ms}ms`,
  );

  // the variant's toolchain builds with no network, under Landlock's
  // read-only /usr, its caches and the Rust toolchain in HOME
  const builds: Record<SandboxVariant, string> = {
    python: `python3 -c 'print("built", 6 * 7)'`,
    bun: `node -e 'console.log("built", 6 * 7)'`,
    go: `mkdir -p "$HOME/cgo" && cd "$HOME/cgo" && printf 'package main\\n\\n// static int twice(int x) { return 2 * x; }\\nimport "C"\\nimport "fmt"\\n\\nfunc main() { fmt.Println("built", C.twice(21)) }\\n' > main.go && go run main.go`,
    rust: `cd "$HOME" && cargo new -q --offline built && cd built && printf 'fn main() { println!("built {}", 6 * 7); }\\n' > src/main.rs && cargo run -q --offline`,
  };
  // in a subshell, so the chat's cwd stays for the steps after
  const built = await command(chat, `(${builds[variant]})`, 120_000);
  report(
    `the ${variant} variant builds and runs a program offline`,
    (built.answer?.stdout ?? "").includes("built 42"),
    `${built.total}ms; ${brief((built.answer?.stdout ?? "") + (built.answer?.stderr ?? ""))}`,
  );

  const warm = await command(chat, "true");
  report(
    "a warm command with nothing changed pushes nothing",
    // a cwd under /tmp is checked by one exec before the command
    !warm.steps.some((s) => s.step === "push") && warm.state === "idle",
    `total ${warm.total}ms: ${stepsOf(warm.steps)}`,
  );

  repoDir = mkdtempSync(join(flags["repo-dir"] ?? tmpdir(), "sandbox-check-"));
  writeFileSync(join(repoDir, "README.md"), "repo\n");
  const withRepo = rows("check-repo", [{ name: "app", tree: repoDir }]);
  const repo = await command(
    withRepo,
    "cat /repos/app/README.md; echo x > /repos/app/new.txt; echo exit=$?; cd /repos/app",
  );
  report(
    "a repository reads, refuses a write and holds the cwd",
    (repo.answer?.stdout ?? "").includes("repo") &&
      /exit=1/.test(repo.answer?.stdout ?? "") &&
      repo.answer?.changes?.cwd === "/repos/app",
    `${brief((repo.answer?.stdout ?? "") + (repo.answer?.stderr ?? ""))}; cwd ${repo.answer?.changes?.cwd}`,
  );

  const linked = rows("check-link");
  const hard = await command(linked, "ln /knowledge/a.md /knowledge/hard.md");
  report(
    "a hard link in /knowledge saves nothing and recycles",
    hard.answer?.changes === null && hard.state !== "idle",
    `refused ${hard.answer?.refused}; state ${hard.state}`,
  );

  const slow = rows("check-slow");
  const timeout = await command(slow, "echo before; sleep 30", 3000);
  report(
    "a timeout answers 124 and recycles",
    timeout.answer?.exitCode === 124 && timeout.state !== "idle",
    `exit ${timeout.answer?.exitCode}, stdout ${brief(timeout.answer?.stdout ?? "")}, total ${timeout.total}ms, state ${timeout.state}`,
  );

  const big = rows("check-big");
  for (let i = 0; i < 400; i++)
    big.docs.set(`many/f${i}.md`, {
      id: `doc-many-${i}`,
      revision: 1,
      updatedAt: Date.now(),
      text: `${i}\n`.repeat(100),
    });
  const bigFirst = await command(big, "true");
  const bigWarm = await command(big, "true");
  report(
    "400 docs: a first push, then a warm walk",
    bigWarm.state === "idle",
    `first ${bigFirst.total}ms (${stepsOf(bigFirst.steps)}); warm ${bigWarm.total}ms (${stepsOf(bigWarm.steps)})`,
  );

  // a command past the 20 s call timeout, on the sandbox's own time
  const long = rows("check-long");
  const slept = await command(
    long,
    "sleep 30; echo slept",
    limits.sandboxCommandSeconds * 1000,
  );
  report(
    "a 30 s command runs to its end on the sandbox's command time",
    slept.answer?.exitCode === 0 &&
      (slept.answer?.stdout ?? "") === "slept\n" &&
      slept.state === "idle",
    `exit ${slept.answer?.exitCode}, ${slept.total}ms, ${slept.state}`,
  );
  // the slot is freed before the command's exec and taken after it: the
  // count is the execs ended by then
  const exec = slept.steps.findIndex((s) => s.step === "command");
  report(
    "the process slot is free while the command runs in the sandbox",
    slept.slots.join(",") === `free ${exec},take ${exec + 1}`,
    `${slept.slots.join(", ")}; ${stepsOf(slept.steps)}`,
  );

  // past the old 512 MiB home tmpfs: the container's disk takes it
  const disk = rows("check-disk");
  const twoGiB = await command(
    disk,
    "dd if=/dev/zero of=$HOME/big bs=1M count=2048 status=none && ls -l $HOME/big && rm $HOME/big && echo removed",
    120_000,
  );
  report(
    "a 2 GiB file in $HOME is written and removed",
    twoGiB.answer?.exitCode === 0 &&
      (twoGiB.answer?.stdout ?? "").includes("2147483648") &&
      (twoGiB.answer?.stdout ?? "").includes("removed") &&
      twoGiB.state === "idle",
    `exit ${twoGiB.answer?.exitCode}, ${twoGiB.total}ms, ${twoGiB.state}; ${brief((twoGiB.answer?.stdout ?? "") + (twoGiB.answer?.stderr ?? ""))}`,
  );

  // /tmp lasts with the sandbox, a command's own exit 126 included,
  // and goes when it is recycled, as a cleared chat's is
  const keep = rows("check-keep");
  await command(keep, "echo kept > /tmp/keep.txt");
  const own = await command(keep, "exit 126");
  const kept = await command(keep, "cat /tmp/keep.txt");
  report(
    "a command's own exit 126 commits and keeps the sandbox",
    own.answer?.exitCode === 126 &&
      own.answer.stopped === undefined &&
      own.state === "idle" &&
      own.hold.sandbox === kept.hold.sandbox,
    `exit ${own.answer?.exitCode}, stopped ${own.answer?.stopped}, ${own.state}`,
  );
  leases.recycleOf({ sessionId: keep.workspace, reason: "clear" });
  const gone = await command(keep, "cat /tmp/keep.txt 2>&1; true");
  report(
    "/tmp lasts between commands and goes with a recycle",
    (kept.answer?.stdout ?? "") === "kept\n" &&
      kept.hold.sandbox !== gone.hold.sandbox &&
      (gone.answer?.stdout ?? "").includes("No such file"),
    `kept ${brief(kept.answer?.stdout ?? "")}; after recycle ${brief(gone.answer?.stdout ?? "")}`,
  );
}

// the repository folder this run made, the only one it removes
let repoDir: string | null = null;

async function cleanup() {
  if (repoDir !== null) rmSync(repoDir, { recursive: true, force: true });
  leases.drain();
  const labels = { [INSTANCE_LABEL]: instanceId };
  const deadline = Date.now() + 120_000;
  for (;;) {
    // a failed list is asked again, never read as nothing left
    const left = await real
      .list(labels, AbortSignal.timeout(10_000))
      .catch(() => null);
    if (left?.length === 0) break;
    if (Date.now() > deadline) {
      report(
        "cleanup",
        false,
        left === null
          ? "the sandboxes could not be listed"
          : `${left.map((s) => s.name).join(", ")} still listed`,
      );
      return;
    }
    for (const box of left ?? [])
      await real.delete(box.name, AbortSignal.timeout(10_000)).catch(() => {});
    await Bun.sleep(1000);
  }
  console.log(`cleanup: every sandbox of instance ${instanceId} deleted`);
}

try {
  await main();
} catch (error) {
  report("run", false, error instanceof Error ? error.message : String(error));
} finally {
  await cleanup();
  real.close();
}
const failed = results.filter((each) => !each.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
