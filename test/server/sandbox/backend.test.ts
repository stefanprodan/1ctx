// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox backend end to end over the fake gateway's filesystem:
// the push of what changed, the command, the fence, the walk and pull,
// the read back by the shared rules, the settle that puts the sandbox
// back to the rows or recycles it.

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { manifestOf, wantedOf } from "../../../src/server/sandbox/baseline.ts";
import { walkBounds } from "../../../src/server/sandbox/bounds.ts";
import { SandboxUnavailable } from "../../../src/server/sandbox/gateway.ts";
import { MAX_KNOWLEDGE_SEGMENTS } from "../../../src/shared/words.ts";
import { answerOf, bytes, pushes, setup } from "./backend-helpers.ts";

// a command that runs until its exec is stopped
const hang = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason));
  });

// scratch rows a sandbox never holds: its /tmp is its own
const ROWS = {
  knowledge: { "a.md": "hello\n", "notes/b.md": "b\n" },
  scratch: { "notes.txt": "x", "run.sh": { text: "echo", mode: 0o755 } },
  scratchRevision: 3,
  usedAt: 500,
  uploads: { "in/data.csv": "1,2\n" },
  kept: { "/mcp/0001-read/result.txt": "kept" },
};

describe("the sandbox backend", () => {
  test("a first command pushes every row but scratch, with its mode and time", async () => {
    const t = setup();
    const ran = await t.run(ROWS);
    expect(ran.fs.tree()).toEqual({
      "/knowledge/a.md": "644 101 hello\n",
      "/knowledge/notes": "dir 755 101",
      "/knowledge/notes/b.md": "644 101 b\n",
      "/mcp/0001-read": "dir 755 0",
      "/mcp/0001-read/result.txt": "644 0 kept",
      "/uploads/in": "dir 755 50",
      "/uploads/in/data.csv": "644 50 1,2\n",
    });
    expect(ran.phases).toEqual(["run", "diff"]);
    expect(answerOf(ran.settled).changes).toEqual({
      knowledge: [],
      written: [],
      removed: [],
      cwd: "/knowledge",
    });
    ran.settle({ landed: false, why: "skipped" });
  });

  test("a command past the gateway's 32 KiB argument runs, as stdin", async () => {
    const t = setup();
    const command = `cat > /tmp/big.md <<'EOF'\n${"line\n".repeat(8000)}EOF`;
    const ran = await t.run(ROWS, {}, { command });
    expect(answerOf(ran.settled).exitCode).toBe(0);
    ran.settle({ landed: false, why: "skipped" });
  });

  test("a warm command with nothing changed pushes nothing", async () => {
    const t = setup();
    const first = await t.run(ROWS);
    first.settle(t.landed(ROWS, answerOf(first.settled), 900));
    expect(await t.settled(first.hold)).toBe("idle");
    expect(first.fs.tree()["/tmp/notes.txt"]).toBeUndefined();
    const after = { ...ROWS, scratchRevision: 4, usedAt: 900 };
    const reads: number[] = [];
    const calls = first.fs.calls.length;
    const second = await t.run(after, {}, { reads });
    expect(second.hold.sandbox).toBe(first.hold.sandbox);
    expect(second.fs.calls.slice(calls)).toEqual([
      "command",
      "fence",
      "walk",
      "pull",
      "records",
    ]);
    // a kept file is read only when its row is new
    expect(reads).toEqual([]);
    second.settle(t.landed(after, answerOf(second.settled)));
    expect(await t.settled(second.hold)).toBe("idle");
  });

  test("the baseline after a commit holds the stored text, and a page's edit is pushed next", async () => {
    const t = setup();
    const ran = await t.run(ROWS, ({ fs }) => {
      fs.write("/knowledge/a.md", "﻿world\n");
      fs.write("/tmp/new/c.txt", "c", 0o600);
      fs.remove("/tmp/notes.txt");
      return { pwd: "/tmp/new" };
    });
    const answer = answerOf(ran.settled);
    // /tmp is the sandbox's: no scratch change, the cwd there kept
    expect(answer.changes).toEqual({
      knowledge: [{ name: "a.md", text: "world\n" }],
      written: [],
      removed: [],
      cwd: "/tmp/new",
    });
    // the commit stored the text without its BOM
    ran.settle(t.landed(ROWS, answer, 900));
    expect(await t.settled(ran.hold)).toBe("idle");
    expect(ran.fs.tree()).toMatchObject({
      "/knowledge/a.md": "644 900 world\n",
      // the put-back leaves /tmp as the command left it
      "/tmp/new": "dir 755 0",
      "/tmp/new/c.txt": "600 0 c",
    });
    // the next command's rows: a.md as committed, b.md edited on a page
    const next = {
      ...ROWS,
      knowledge: { "a.md": "world\n", "notes/b.md": "b2\n" },
      revisions: { "a.md": 2, "notes/b.md": 2 },
      times: { "a.md": 900 },
      scratch: {
        "new/c.txt": { text: "c", mode: 0o600 },
        "run.sh": { text: "echo", mode: 0o755 },
      },
      scratchRevision: 4,
      usedAt: 900,
      cwd: "/tmp/new",
    };
    const t2 = await t.run(next);
    // only the page's edit went: one push frame for b.md and its folder
    expect(t2.fs.tree()["/knowledge/notes/b.md"]).toBe("644 102 b2\n");
    expect(t2.fs.tree()["/knowledge/a.md"]).toBe("644 900 world\n");
    expect(answerOf(t2.settled).changes?.cwd).toBe("/tmp/new");
    expect(answerOf(t2.settled).notice).toBe("");
    t2.settle({ landed: false, why: "skipped" });
  });

  test("scratch rows that moved are never pushed", async () => {
    const t = setup();
    const first = await t.run(ROWS);
    first.settle(t.landed(ROWS, answerOf(first.settled), 900));
    await t.settled(first.hold);
    const pushed = pushes(first.fs);
    const back = {
      ...ROWS,
      scratch: { ...ROWS.scratch, "from-child.txt": "y" },
      scratchRevision: 5,
      usedAt: 950,
    };
    const ran = await t.run(back);
    expect(pushes(ran.fs)).toBe(pushed);
    expect(ran.fs.tree()["/tmp/from-child.txt"]).toBeUndefined();
    ran.settle({ landed: false, why: "skipped" });
  });

  test("/tmp is never walked or pulled, and a command there saves no scratch", async () => {
    const t = setup();
    const ran = await t.run(ROWS, ({ fs }) => {
      fs.write("/tmp/big.bin", "x".repeat(100_000));
      fs.nodes.set("/tmp/link", { kind: "link", target: "/" });
      fs.nodes.set("/tmp/fifo", { kind: "other", mode: 0o644 });
      fs.nodes.set("/tmp/new", { kind: "dir", mode: 0o700, mtime: 0 });
      return { pwd: "/tmp/new" };
    });
    const answer = answerOf(ran.settled);
    expect(answer.refused).toBeNull();
    expect(answer.changes).toEqual({
      knowledge: [],
      written: [],
      removed: [],
      cwd: "/tmp/new",
    });
    const asked = ran.fs.pulled.map((stdin) => new TextDecoder().decode(stdin));
    expect(asked.some((text) => text.includes("/tmp/"))).toBe(false);
    ran.settle(t.landed(ROWS, answer, 900));
    expect(await t.settled(ran.hold)).toBe("idle");
    expect(ran.fs.frames.some((frame) => frame.includes(" /tmp"))).toBe(false);
    expect(ran.fs.tree()["/tmp/big.bin"]).toBeDefined();
  });

  test("a push frames a delete, a file turned folder and a time", () => {
    const job = setup().jobOf;
    const old = { knowledge: { a: "1", b: "2", "d/e": "3" } };
    const before = wantedOf(
      job(old, "").job,
      job(old, "").mounted,
      () => null,
      null,
    );
    const rows = {
      knowledge: { "a/x": "1", b: "2", "d/e": "3" },
      revisions: { b: 2 },
    };
    const { job: next, mounted } = job(rows, "");
    const wanted = wantedOf(next, mounted, () => null, before.tree);
    const manifest = manifestOf(before.tree, wanted);
    expect(manifest.remove).toEqual(["/knowledge/a"]);
    expect(manifest.folders).toEqual([
      { path: "/knowledge/a", mode: 0o755, mtime: 101 },
    ]);
    expect(manifest.files?.map((file) => file.path)).toEqual([
      "/knowledge/a/x",
    ]);
    expect(manifest.meta).toEqual([
      { path: "/knowledge/b", mode: 0o644, mtime: 102 },
    ]);
  });

  test("a walk that leaves an entry out or lies about a hash recycles", async () => {
    for (const lie of ["drop", "hash"] as const) {
      const t = setup();
      t.fake.onFiles = (_, fs) => {
        fs.walkLines = (lines) =>
          lie === "drop"
            ? lines.filter((line) => !line.endsWith("/knowledge/a.md"))
            : lines.map((line) =>
                line.endsWith("/knowledge/a.md")
                  ? line.replace(/ [0-9a-f]{64} /, ` ${"0".repeat(64)} `)
                  : line,
              );
      };
      const ran = await t.run(ROWS, ({ fs }) => {
        fs.write("/knowledge/a.md", "changed");
        return {};
      });
      const answer = answerOf(ran.settled);
      expect(answer.changes).toBeNull();
      expect(answer.refused).toContain("nothing was saved");
      ran.settle({ landed: false, why: "thrown" });
      expect(await t.settled(ran.hold)).not.toBe("idle");
    }
  });

  test("every change that cannot commit recycles, after the rest commits", async () => {
    const cases: [
      string,
      (fs: import("../../helpers/sandbox-fs.ts").FakeFs) => void,
      object?,
    ][] = [
      ["/uploads", (fs) => fs.write("/uploads/in/data.csv", "3,4\n")],
      ["/mcp", (fs) => fs.write("/mcp/extra", "x")],
      [
        "/knowledge",
        (fs) => fs.write("/knowledge/new.md", "x\n"),
        { docs: false, cwd: "/tmp" },
      ],
      [
        "/uploads",
        (fs) =>
          fs.nodes.set("/uploads/in/data.csv", {
            kind: "file",
            mode: 0o600,
            mtime: 0,
            data: bytes("1,2\n"),
          }),
      ],
    ];
    for (const [root, change, extra] of cases) {
      const t = setup();
      const rows = { ...ROWS, ...extra };
      const docs = !("docs" in rows) || rows.docs !== false;
      const ran = await t.run(rows, ({ fs }) => {
        change(fs);
        if (docs) fs.write("/knowledge/kept.md", "y\n");
        return {};
      });
      const answer = answerOf(ran.settled);
      if (!answer.notice.includes(root)) expect(root).toBe("/uploads");
      expect(answer.changes?.knowledge).toEqual(
        docs ? [{ name: "kept.md", text: "y\n" }] : [],
      );
      ran.settle(t.landed(rows, answer));
      expect(await t.settled(ran.hold)).not.toBe("idle");
    }
  });

  test("a command's own exit 124 or 126 saves as any other", async () => {
    const t = setup();
    for (const exit of [124, 126]) {
      const ran = await t.run(ROWS, ({ fs }) => {
        fs.write("/knowledge/a.md", `${exit}\n`);
        return { exit, stderr: "Permission denied\n" };
      });
      const answer = answerOf(ran.settled);
      expect(answer).toMatchObject({ exitCode: exit, refused: null });
      expect(answer.stopped).toBeUndefined();
      expect(answer.changes?.knowledge).toEqual([
        { name: "a.md", text: `${exit}\n` },
      ]);
      ran.settle(t.landed(ROWS, answer));
      expect(await t.settled(ran.hold)).toBe("idle");
    }
  });

  test("a planted record, a refused tree, an abort and a lost launch recycle", async () => {
    const t = setup();
    // the wrapper's own refusal, which says nothing else
    const limit = await t.run(ROWS, {
      exit: 126,
      stderr: "WRAPPER records exist\n",
    });
    expect(answerOf(limit.settled)).toMatchObject({
      exitCode: 126,
      changes: null,
      refused: null,
      stopped: "limit",
    });
    expect(limit.fs.calls).not.toContain("walk");
    limit.settle({ landed: false, why: "skipped" });
    expect(await t.settled(limit.hold)).not.toBe("idle");

    const link = await t.run(ROWS, ({ fs }) => {
      fs.nodes.set("/knowledge/link", { kind: "link", target: "/" });
      return {};
    });
    expect(answerOf(link.settled).refused).toBe(
      "/knowledge/link is not a regular file",
    );
    link.settle({ landed: false, why: "skipped" });
    expect(await t.settled(link.hold)).not.toBe("idle");

    const stop = new AbortController();
    const aborted = await t.run(
      ROWS,
      ({ signal }) => {
        stop.abort();
        return hang(signal);
      },
      { stop },
    );
    expect(aborted.settled).toMatchObject({
      ok: false,
      phase: "run",
      cause: "abort",
    });
    aborted.settle({ landed: false, why: "skipped" });
    expect(await t.settled(aborted.hold)).not.toBe("idle");

    t.fake.onFiles = (_, fs) => fs.broken.set("command", "throw");
    const lost = await t.run(ROWS);
    expect(lost.settled).toMatchObject({
      ok: false,
      phase: "run",
      cause: "error",
    });
    expect(lost.fs.calls.filter((step) => step === "command")).toEqual([
      "command",
    ]);
    lost.settle({ landed: false, why: "skipped" });
    expect(await t.settled(lost.hold)).not.toBe("idle");
  });

  test("the deadline ends the command at 124 and recycles", async () => {
    const t = setup();
    const pending = t.run(ROWS, ({ signal }) => {
      t.time.advance(20_000);
      return hang(signal);
    });
    const ran = await pending;
    expect(answerOf(ran.settled)).toMatchObject({
      exitCode: 124,
      changes: null,
      refused: null,
      stopped: "deadline",
    });
    expect(ran.fs.calls).not.toContain("walk");
    ran.settle({ landed: false, why: "skipped" });
    expect(await t.settled(ran.hold)).not.toBe("idle");
  });

  test("a sandbox the gateway calls not ready is reported to the leases", async () => {
    for (const step of ["push", "command", "walk"] as const) {
      const t = setup();
      t.fake.onFiles = (_, fs) => fs.broken.set(step, "unavailable");
      const ran = await t.run(ROWS);
      expect(ran.failed.count).toBe(1);
      ran.settle({ landed: false, why: "skipped" });
      expect(await t.settled(ran.hold)).not.toBe("idle");
    }
  });

  test("a failed fence or push saves nothing and recycles", async () => {
    for (const step of ["fence", "push"] as const) {
      const t = setup();
      t.fake.onFiles = (_, fs) => fs.broken.set(step, "exit");
      const ran = await t.run(ROWS);
      if (step === "fence")
        expect(answerOf(ran.settled).refused).toContain(
          "could not all be stopped",
        );
      else
        expect(ran.settled).toMatchObject({
          ok: false,
          phase: "mount",
          cause: "error",
        });
      ran.settle({ landed: false, why: "skipped" });
      expect(await t.settled(ran.hold)).not.toBe("idle");
    }
  });

  test("open's copies come back as records, and a subagent's are never read", async () => {
    const t = setup();
    const ran = await t.run(ROWS, ({ open }) => ({
      opened: open ? [{ path: "/knowledge/a.md", text: "hello\n" }] : [],
    }));
    expect(answerOf(ran.settled).opened).toEqual([
      {
        path: "/knowledge/a.md",
        kind: "markdown",
        language: null,
        bytes: 6,
        lines: 1,
        title: null,
        text: "hello\n",
      },
    ]);
    ran.settle({ landed: false, why: "skipped" });

    const child = setup();
    const sub = await child.run(
      { ...ROWS, subagent: true },
      ({ open, id, fs }) => {
        expect(open).toBe(false);
        fs.write(`/sandbox/.1ctx/${id}.opened/1`, "x");
        fs.write(`/sandbox/.1ctx/${id}.opened/1.path`, "/tmp/notes.txt\n");
        return {};
      },
    );
    expect(answerOf(sub.settled).opened).toEqual([]);
    sub.settle({ landed: false, why: "skipped" });
  });

  test("a cwd record missing or not UTF-8 keeps the start, and records are removed", async () => {
    const t = setup();
    const missing = await t.run({ ...ROWS, cwd: "/tmp" }, { pwd: null });
    expect(answerOf(missing.settled).changes?.cwd).toBe("/tmp");
    missing.settle({ landed: false, why: "skipped" });
    const invalid = await t.run(
      { ...ROWS, cwd: "/uploads/in" },
      ({ fs, id }) => {
        fs.nodes.set(`/sandbox/.1ctx/${id}.cwd`, {
          kind: "file",
          mode: 0o644,
          mtime: 0,
          data: new Uint8Array([0xff]),
        });
        return { pwd: null };
      },
    );
    expect(answerOf(invalid.settled).changes?.cwd).toBe("/uploads/in");
    expect(
      [...invalid.fs.nodes.keys()].filter((path) =>
        path.startsWith("/sandbox/.1ctx/"),
      ),
    ).toEqual([]);
    invalid.settle({ landed: false, why: "skipped" });
    // a start whose folder is gone says so
    const gone = await t.run({ ...ROWS, cwd: "/tmp/gone" });
    expect(answerOf(gone.settled).notice).toBe(
      "started in /knowledge: /tmp/gone no longer exists\n",
    );
    gone.settle({ landed: false, why: "skipped" });
  });

  test("a subagent's write to /knowledge saves as its parent's, and its sandbox stays", async () => {
    const t = setup();
    const ran = await t.run({ ...ROWS, subagent: true }, ({ fs }) => {
      fs.write("/knowledge/a.md", "mine\n");
      fs.write("/tmp/x", "y");
      return {};
    });
    const answer = answerOf(ran.settled);
    expect(answer).toMatchObject({ refused: null });
    expect(answer.changes?.knowledge).toEqual([
      { name: "a.md", text: "mine\n" },
    ]);
    ran.settle(t.landed(ROWS, answer));
    expect(await t.settled(ran.hold)).toBe("idle");
    expect(ran.fs.tree()["/tmp/x"]).toBe("644 0 y");
  });

  test("output keeps four bytes a result character of each stream and drains the rest", async () => {
    const t = setup();
    const ran = await t.run(
      { ...ROWS, resultCut: 1 },
      { stdout: "abcdefgh", stderr: "123456" },
    );
    expect(answerOf(ran.settled)).toMatchObject({
      stdout: "abcd",
      stderr: "1234",
      exitCode: 0,
    });
    ran.settle({ landed: false, why: "skipped" });
  });
});

describe("records, kept reads, put-back frames and a lost sandbox", () => {
  test("the records folder is emptied after a command, whatever a command left there", async () => {
    const t = setup();
    const ran = await t.run(ROWS, ({ fs }) => {
      fs.write("/sandbox/.1ctx/junk", "x".repeat(1000));
      fs.write("/sandbox/.1ctx/deep/er/file", "y");
      return {};
    });
    expect(answerOf(ran.settled).changes).not.toBeNull();
    expect(
      [...ran.fs.nodes.keys()].filter((path) =>
        path.startsWith("/sandbox/.1ctx/"),
      ),
    ).toEqual([]);
    expect(ran.fs.nodes.has("/sandbox/.1ctx")).toBe(true);
    ran.settle({ landed: false, why: "skipped" });
  });

  test.each([
    ["throws", true],
    ["finds no row", "gone"],
  ] as const)(
    "a kept file whose read %s runs nothing and saves nothing",
    async (_, keptFails) => {
      const t = setup();
      const ran = await t.run(ROWS, {}, { keptFails });
      expect(ran.settled).toMatchObject({
        ok: false,
        phase: "mount",
        cause: "error",
      });
      if (!ran.settled.ok)
        expect(ran.settled.error?.message).toBe(
          "the kept file could not be read",
        );
      expect(ran.fs.calls).not.toContain("command");
      ran.settle({ landed: false, why: "skipped" });
      expect(await t.settled(ran.hold)).not.toBe("idle");
    },
  );

  test("a put-back frames only what changed and the times that moved", async () => {
    const t = setup();
    const first = await t.run(ROWS);
    first.settle(t.landed(ROWS, answerOf(first.settled), 900));
    await t.settled(first.hold);
    const after = { ...ROWS, scratchRevision: 4, usedAt: 900 };
    const frames = first.fs.frames.length;
    const second = await t.run(after, ({ fs }) => {
      fs.write("/knowledge/a.md", "\uFEFFnew\n");
      return {};
    });
    second.settle(t.landed(after, answerOf(second.settled), 950));
    expect(await t.settled(second.hold)).toBe("idle");
    // the doc as stored, without its BOM, at its new time; nothing else
    expect(second.fs.frames.slice(frames)).toEqual(["file /knowledge/a.md"]);
    expect(second.fs.tree()["/knowledge/a.md"]).toBe("644 950 new\n");
  });

  test("an unavailable sandbox is reported on the deadline's path and after a command's exit", async () => {
    const t = setup();
    t.fake.onFiles = (_, fs) => {
      fs.walkLines = () => {
        t.time.advance(20_000);
        throw new SandboxUnavailable("sandbox is not ready");
      };
    };
    const late = await t.run(ROWS);
    expect(answerOf(late.settled).exitCode).toBe(124);
    expect(late.failed.count).toBe(1);
    late.settle({ landed: false, why: "skipped" });

    const limit = setup();
    limit.fake.onFiles = (_, fs) => fs.broken.set("fence", "unavailable");
    const ran = await limit.run(ROWS, { exit: 126 });
    expect(ran.settled).toMatchObject({ ok: false, cause: "error" });
    expect(ran.failed.count).toBe(1);
    ran.settle({ landed: false, why: "skipped" });
  });
});

describe("the walk's bounds", () => {
  test("the caps, or what the trees held when more", () => {
    const caps = {
      ...DEFAULT_LIMITS,
      knowledgeProjectBytes: 100,
      knowledgeFileBytes: 100,
      uploadBytes: 100,
      mcpKeptBytes: 100,
    };
    const small = walkBounds(caps, null);
    const t = setup();
    const { job, mounted } = t.jobOf(
      { knowledge: { a: "x".repeat(5000) } },
      "",
    );
    const held = wantedOf(job, mounted, () => null, null).tree;
    const big = walkBounds(caps, held);
    expect(big.limits.fileBytes).toBeGreaterThanOrEqual(5000);
    expect(big.limits.totalBytes - small.limits.totalBytes).toBe(5000 - 100);
    // scratch is not the walk's: its caps never move the bounds
    expect(walkBounds({ ...caps, scratchBytes: 1 << 26 }, null)).toEqual(small);
    // a doc counts its folders too, at the most segments a name holds
    const docs = {
      ...caps,
      knowledgeFiles: 10,
      uploadFiles: 0,
      mcpKeptFiles: 0,
    };
    expect(walkBounds(docs, null).limits.entries).toBe(
      10 * MAX_KNOWLEDGE_SEGMENTS + 64,
    );
  });

  test("a walk past them recycles, and a tree over a lowered cap still shrinks", async () => {
    const t = setup({
      knowledgeFiles: 1,
      uploadFiles: 1,
      mcpKeptFiles: 1,
    });
    const over = await t.run({}, ({ fs }) => {
      for (let i = 0; i < 100; i++) fs.write(`/knowledge/f${i}`, "x");
      return {};
    });
    expect(answerOf(over.settled).refused).toBe(
      "the files are past the limits, so nothing was saved",
    );
    over.settle({ landed: false, why: "skipped" });
    expect(await t.settled(over.hold)).not.toBe("idle");

    const rows = {
      knowledge: Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [`f${i}`, "x"]),
      ),
    };
    const shrink = await t.run(rows);
    shrink.settle(t.landed(rows, answerOf(shrink.settled)));
    expect(await t.settled(shrink.hold)).toBe("idle");
    const ran = await t.run(rows, ({ fs }) => {
      fs.remove("/knowledge/f0");
      return {};
    });
    expect(answerOf(ran.settled).changes?.knowledge).toEqual([
      { name: "f0", text: null },
    ]);
    ran.settle({ landed: false, why: "skipped" });
  });
});
