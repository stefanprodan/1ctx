// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One sandbox for a chat and its subagents: their commands join one
// lease and run at once, their pushes and saves take turns, each save
// takes every /knowledge change since the last one and reads it against
// the rows as they stand, a recycle stops the others cleanly, and the
// idle clock starts when the last command lets go.

import { describe, expect, test } from "bun:test";
import type {
  Answer,
  SettleOutcome,
  ShellCall,
} from "../../../src/server/bash/index.ts";
import type { MountedDoc } from "../../../src/server/knowledge/index.ts";
import { MINUTE_MS } from "../../../src/server/lib/clock.ts";
import { RECYCLED } from "../../../src/server/sandbox/backend.ts";
import type { SandboxHold } from "../../../src/server/sandbox/index.ts";
import { sharedOf } from "../../../src/server/sandbox/shared.ts";
import { rejection } from "../../helpers/async.ts";
import { until } from "../../helpers/sandbox.ts";
import type { CommandCall } from "../../helpers/sandbox-fs.ts";
import { answerOf, bytes, type Rows, setup } from "./backend-helpers.ts";

const ROWS = { knowledge: { "a.md": "a\n", "b.md": "b\n" } };

// the doc rows of the project, as a commit would leave them
function store(initial: Record<string, string>) {
  const docs = new Map(
    Object.entries(initial).map(([name, text]) => [
      name,
      { revision: 1, updatedAt: 101, text },
    ]),
  );
  const read = (): MountedDoc[] =>
    [...docs].map(([name, doc]) => ({
      id: `doc-${name}`,
      projectId: "project",
      name,
      kind: "md",
      bytes: doc.text.length,
      lines: 1,
      tokens: 1,
      revision: doc.revision,
      author: {
        kind: "agent",
        id: "a",
        name: "a",
        sessionId: null,
        origin: null,
        keyName: null,
      },
      createdAt: 1,
      updatedAt: doc.updatedAt,
      data: bytes(doc.text),
    }));
  // another chat's write, or a commit's
  const write = (name: string, text: string | null, now: number) => {
    const revision = (docs.get(name)?.revision ?? 0) + 1;
    if (text === null) docs.delete(name);
    else docs.set(name, { revision, updatedAt: now, text });
    return { name, id: `doc-${name}`, revision, updatedAt: now, text };
  };
  const commit = (answer: Answer, now: number): SettleOutcome => ({
    landed: true,
    docs: (answer.changes?.knowledge ?? []).map((change) =>
      write(change.name, change.text, now),
    ),
    scratch: { revision: 1, usedAt: now },
  });
  const text = (name: string) => docs.get(name)?.text;
  return { read, write, commit, text };
}

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

// turns of the microtask queue in which nothing may move
async function stays(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    await Promise.resolve();
    expect(check()).toBe(true);
  }
}

// a subagent's call into the chat's sandbox
const leaseCall = (workspace: string): ShellCall => ({
  projectId: "project",
  workspace: { id: workspace, sessionId: workspace },
  root: "chat",
  sendId: "send",
  subagent: workspace !== "chat",
  repos: [],
  repoFileBytes: 0,
  network: false,
  credentials: [],
});

describe("a sandbox shared by a chat and its subagents", () => {
  test("a subagent's command joins its parent's sandbox, which counts once at the cap", async () => {
    const t = setup({ sandboxesMax: 1 });
    const rows = store(ROWS.knowledge);
    const started = gate();
    const release = gate();
    const parent = t.run(
      ROWS,
      async () => {
        started.open();
        await release.opened;
        return {};
      },
      { command: "parent", docs: rows.read },
    );
    await started.opened;
    const child = await t.run(
      { ...ROWS, workspace: "child", subagent: true },
      {},
      { command: "child", docs: rows.read },
    );
    expect(t.fake.creates).toHaveLength(1);
    expect(t.leases.counted()).toBe(1);
    expect(t.leases.rows()).toMatchObject([
      { workspace: "chat", state: "leased" },
    ]);
    child.settle(rows.commit(answerOf(child.settled), t.time.now()));
    await t.backend.idle();
    // the parent still holds it: a child's end recycles nothing
    expect(t.leases.rows()).toMatchObject([{ state: "leased" }]);
    release.open();
    const done = await parent;
    expect(done.hold.sandbox).toBe(child.hold.sandbox);
    done.settle(rows.commit(answerOf(done.settled), t.time.now()));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(t.fake.deletes).toEqual([]);
  });

  test("overlapping commands run at once, and each save waits for the one before and takes all since it", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const started = gate();
    const release = gate();
    let parentDone = false;
    const parent = t
      .run(
        ROWS,
        async ({ fs }: CommandCall) => {
          fs.write("/knowledge/c.md", "c\n");
          started.open();
          await release.opened;
          fs.write("/knowledge/a.md", "a2\n");
          return {};
        },
        { command: "parent", docs: rows.read },
      )
      .then((ran) => {
        parentDone = true;
        return ran;
      });
    await started.opened;
    const child = await t.run(
      { ...ROWS, workspace: "child", subagent: true },
      ({ fs }) => {
        fs.write("/knowledge/b.md", "b2\n");
        return {};
      },
      { command: "child", docs: rows.read },
    );
    const fs = child.fs;
    // the parent's c.md, midway through its command, saves with the
    // child's change; with the parent running nothing is fenced
    expect(answerOf(child.settled).changes?.knowledge).toEqual([
      { name: "b.md", text: "b2\n" },
      { name: "c.md", text: "c\n" },
    ]);
    // nothing moved the base since the child read its rows
    expect(child.rows).toBeUndefined();
    expect(fs.calls).not.toContain("fence");
    // the child's turn lasts until its put-back: the parent's save waits
    release.open();
    const walks = fs.calls.filter((step) => step === "walk").length;
    await stays(
      () =>
        !parentDone &&
        fs.calls.filter((step) => step === "walk").length === walks,
    );
    child.settle(rows.commit(answerOf(child.settled), t.time.now()));
    const ran = await parent;
    // only what changed since the child's save is the parent's, read
    // against the rows the child's save left
    expect(answerOf(ran.settled).changes?.knowledge).toEqual([
      { name: "a.md", text: "a2\n" },
    ]);
    expect(ran.rows?.map((row) => [row.name, row.revision])).toEqual([
      ["a.md", 1],
      ["b.md", 2],
      ["c.md", 1],
    ]);
    // alone at its end, the parent's save fences every process
    expect(fs.calls.filter((step) => step === "fence")).toHaveLength(1);
    ran.settle(rows.commit(answerOf(ran.settled), t.time.now()));
    expect(await t.settled(ran.hold)).toBe("idle");
    expect(rows.text("a.md")).toBe("a2\n");
    expect(rows.text("b.md")).toBe("b2\n");
    expect(rows.text("c.md")).toBe("c\n");
    expect(fs.tree()["/knowledge/c.md"]).toMatch(/ c\n$/);
  });

  test("a command whose rows a save moved while it waited pushes them as they are now", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const started = gate();
    const release = gate();
    const parent = t.run(
      ROWS,
      async ({ fs }) => {
        started.open();
        await release.opened;
        fs.write("/knowledge/a.md", "saved\n");
        return {};
      },
      { command: "parent", docs: rows.read },
    );
    await started.opened;
    // the child holds the sandbox, then the parent's save takes its turn
    const hold = (await t.leases.acquire(
      {
        projectId: "project",
        workspace: { id: "child", sessionId: "child" },
        root: "chat",
        sendId: "send",
        subagent: true,
        repos: [],
        repoFileBytes: 0,
        network: true,
        credentials: [],
      },
      t.time.now() + 20_000,
      new AbortController().signal,
    )) as SandboxHold;
    release.open();
    const saved = await parent;
    // the child read its rows before that save landed, and waits
    const child = t.run(
      { ...ROWS, workspace: "child", subagent: true },
      ({ fs }) => {
        const node = fs.nodes.get("/knowledge/a.md");
        return {
          stdout:
            node?.kind === "file" ? new TextDecoder().decode(node.data) : "",
        };
      },
      { command: "child", docs: rows.read, hold },
    );
    saved.settle(rows.commit(answerOf(saved.settled), t.time.now()));
    const ran = await child;
    // alone by then, it pushed the rows as the save left them, not its own
    expect(answerOf(ran.settled).stdout).toBe("saved\n");
    expect(answerOf(ran.settled).changes?.knowledge).toEqual([]);
    // its save read the rows its push read, never the job's older ones
    expect(ran.rows?.find((row) => row.name === "a.md")?.revision).toBe(2);
    ran.settle(t.landed(ROWS, answerOf(ran.settled)));
    expect(await t.settled(ran.hold)).toBe("idle");
    // the put-back left the sandbox as the rows hold it
    expect(ran.fs.tree()["/knowledge/a.md"]).toMatch(/ saved\n$/);
  });

  test("a command whose rows a save moved while it waited saves its edit of the moved file", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const started = gate();
    const release = gate();
    const parent = t.run(
      ROWS,
      async ({ fs }) => {
        started.open();
        await release.opened;
        fs.write("/knowledge/a.md", "saved\n");
        return {};
      },
      { command: "parent", docs: rows.read },
    );
    await started.opened;
    const hold = (await t.leases.acquire(
      leaseCall("child"),
      t.time.now() + 20_000,
      new AbortController().signal,
    )) as SandboxHold;
    release.open();
    const saved = await parent;
    const child = t.run(
      { ...ROWS, workspace: "child", subagent: true },
      ({ fs }) => {
        fs.write("/knowledge/a.md", "child\n");
        return {};
      },
      { command: "child", docs: rows.read, hold },
    );
    saved.settle(rows.commit(answerOf(saved.settled), t.time.now()));
    const ran = await child;
    expect(answerOf(ran.settled)).toMatchObject({
      refused: null,
      changes: { knowledge: [{ name: "a.md", text: "child\n" }] },
    });
    expect(ran.rows?.find((row) => row.name === "a.md")?.revision).toBe(2);
    ran.settle(rows.commit(answerOf(ran.settled), t.time.now()));
    expect(await t.settled(ran.hold)).toBe("idle");
    expect(rows.text("a.md")).toBe("child\n");
    expect(ran.fs.tree()["/knowledge/a.md"]).toMatch(/ child\n$/);
  });

  test("beside a running command a save leaves its links, bad names and folders in place", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const started = gate();
    const release = gate();
    const parent = t.run(
      ROWS,
      async ({ fs }) => {
        fs.write("/knowledge/c.md", "c\n");
        fs.nodes.set("/knowledge/l", { kind: "link", target: "/" });
        fs.write("/knowledge/x?.md", "x\n");
        fs.nodes.set("/knowledge/new", { kind: "dir", mode: 0o755, mtime: 0 });
        started.open();
        await release.opened;
        fs.write("/knowledge/new/f.md", "f\n");
        fs.remove("/knowledge/l");
        fs.remove("/knowledge/x?.md");
        return {};
      },
      { command: "parent", docs: rows.read },
    );
    await started.opened;
    const child = await t.run(
      { ...ROWS, workspace: "child", subagent: true },
      ({ fs }) => {
        fs.write("/knowledge/b.md", "b2\n");
        return {};
      },
      { command: "child", docs: rows.read },
    );
    // every valid change saves; what the rules refuse is left alone
    expect(answerOf(child.settled)).toMatchObject({
      refused: null,
      changes: {
        knowledge: [
          { name: "b.md", text: "b2\n" },
          { name: "c.md", text: "c\n" },
        ],
      },
    });
    child.settle(rows.commit(answerOf(child.settled), t.time.now()));
    await t.backend.idle();
    expect(child.hold.lost.aborted).toBe(false);
    expect(child.fs.tree()).toMatchObject({
      "/knowledge/l": "link",
      "/knowledge/x?.md": "644 0 x\n",
      "/knowledge/new": "dir 755 0",
    });
    release.open();
    const done = await parent;
    expect(answerOf(done.settled).changes?.knowledge).toEqual([
      { name: "new/f.md", text: "f\n" },
    ]);
    done.settle(rows.commit(answerOf(done.settled), t.time.now()));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(t.fake.deletes).toEqual([]);
  });

  test("alone, a link left in /knowledge refuses the save and recycles", async () => {
    const t = setup();
    const ran = await t.run(ROWS, ({ fs }) => {
      fs.nodes.set("/knowledge/l", { kind: "link", target: "/" });
      return {};
    });
    expect(answerOf(ran.settled).refused).toBe(
      "/knowledge/l is not a regular file",
    );
    ran.settle({ landed: false, why: "skipped" });
    expect(await t.settled(ran.hold)).not.toBe("idle");
  });

  // a parent's command, which wrote its work in progress, held open
  // while a child's command runs and saves
  async function besideParent(
    t: ReturnType<typeof setup>,
    rows: ReturnType<typeof store>,
    tag: string,
    child: (call: CommandCall) => void,
    parent: {
      early?: (call: CommandCall) => void;
      late?: (call: CommandCall) => void;
      rows?: Rows;
    } = {},
  ) {
    const started = gate();
    const release = gate();
    const running = t.run(
      ROWS,
      async (call) => {
        call.fs.write(`/knowledge/p-${tag}.md`, `${tag}\n`);
        parent.early?.(call);
        started.open();
        await release.opened;
        parent.late?.(call);
        return {};
      },
      { command: `parent-${tag}`, docs: rows.read },
    );
    await started.opened;
    const ran = await t.run(
      { ...(parent.rows ?? ROWS), workspace: "child", subagent: true },
      (call) => {
        child(call);
        return {};
      },
      { command: `child-${tag}`, docs: rows.read },
    );
    return {
      child: ran,
      parent: () => {
        release.open();
        return running;
      },
    };
  }

  test("beside a running command a thrown commit puts nothing back, and a later save takes it all", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const { child, parent } = await besideParent(t, rows, "z", ({ fs }) => {
      fs.write("/knowledge/a.md", "mine\n");
      fs.write("/knowledge/d/new.md", "new\n");
    });
    expect(answerOf(child.settled).changes?.knowledge).toEqual([
      { name: "a.md", text: "mine\n" },
      { name: "d/new.md", text: "new\n" },
      { name: "p-z.md", text: "z\n" },
    ]);
    child.settle({ landed: false, why: "thrown" });
    await t.backend.idle();
    expect(child.hold.lost.aborted).toBe(false);
    expect(child.fs.tree()).toMatchObject({
      "/knowledge/a.md": expect.stringMatching(/ mine\n$/),
      "/knowledge/d/new.md": expect.stringMatching(/ new\n$/),
      "/knowledge/p-z.md": expect.stringMatching(/ z\n$/),
    });
    const done = await parent();
    expect(answerOf(done.settled).changes?.knowledge).toEqual([
      { name: "a.md", text: "mine\n" },
      { name: "d/new.md", text: "new\n" },
      { name: "p-z.md", text: "z\n" },
    ]);
    done.settle(rows.commit(answerOf(done.settled), t.time.now()));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(rows.text("p-z.md")).toBe("z\n");
    expect(t.fake.deletes).toEqual([]);
  });

  test("beside a running command a commit's conflict puts back the doc it names, and a later save takes the rest", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const { child, parent } = await besideParent(t, rows, "m", ({ fs }) => {
      fs.write("/knowledge/a.md", "mine\n");
      fs.write("/knowledge/d/new.md", "new\n");
    });
    // another chat's write after the save read the rows
    rows.write("a.md", "theirs\n", 200);
    expect(child.settle({ landed: false, why: "thrown", moved: "a.md" })).toBe(
      "a.md changed while the command ran, so it was put back; read it again and retry. Other changes stay in the sandbox for a later save.",
    );
    await t.backend.idle();
    expect(child.hold.lost.aborted).toBe(false);
    expect(child.fs.tree()).toMatchObject({
      "/knowledge/a.md": "644 200 theirs\n",
      "/knowledge/d/new.md": expect.stringMatching(/ new\n$/),
      "/knowledge/p-m.md": expect.stringMatching(/ m\n$/),
    });
    const done = await parent();
    expect(answerOf(done.settled).changes?.knowledge).toEqual([
      { name: "d/new.md", text: "new\n" },
      { name: "p-m.md", text: "m\n" },
    ]);
    done.settle(rows.commit(answerOf(done.settled), t.time.now()));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(rows.text("a.md")).toBe("theirs\n");
    expect(t.fake.deletes).toEqual([]);
  });

  test("beside a running command a put-back leaves a file it wrote after the walk, which a later save takes", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const { child, parent } = await besideParent(t, rows, "w", ({ fs }) => {
      // stored without its BOM, so the put-back rewrites the file
      fs.write("/knowledge/a.md", "﻿mine\n");
      // the parent's write lands once the walk read the tree
      fs.pullFrames = (frames) => {
        fs.write("/knowledge/a.md", "parent\n");
        fs.pullFrames = undefined;
        return frames;
      };
    });
    expect(answerOf(child.settled).changes?.knowledge).toEqual([
      { name: "a.md", text: "mine\n" },
      { name: "p-w.md", text: "w\n" },
    ]);
    child.settle(rows.commit(answerOf(child.settled), t.time.now()));
    await t.backend.idle();
    expect(child.hold.lost.aborted).toBe(false);
    expect(child.fs.tree()["/knowledge/a.md"]).toBe("644 0 parent\n");
    const done = await parent();
    expect(answerOf(done.settled).changes?.knowledge).toEqual([
      { name: "a.md", text: "parent\n" },
    ]);
    done.settle(rows.commit(answerOf(done.settled), t.time.now()));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(rows.text("a.md")).toBe("parent\n");
    expect(t.fake.deletes).toEqual([]);
  });

  test("beside a running command a half-written or oversized doc stays unsaved in place, and a later save judges it", async () => {
    const t = setup({ knowledgeFileBytes: 64 });
    const rows = store(ROWS.knowledge);
    const { child, parent } = await besideParent(
      t,
      rows,
      "h",
      ({ fs }) => fs.write("/knowledge/b.md", "b2\n"),
      {
        early: ({ fs }) => {
          fs.write("/knowledge/a.md", "\u0000half");
          fs.write("/knowledge/big.md", "x".repeat(100));
        },
        late: ({ fs }) => {
          fs.write("/knowledge/a.md", "whole\n");
          fs.write("/knowledge/big.md", "small\n");
        },
      },
    );
    expect(answerOf(child.settled)).toMatchObject({
      refused: null,
      changes: {
        knowledge: [
          { name: "b.md", text: "b2\n" },
          { name: "p-h.md", text: "h\n" },
        ],
      },
    });
    child.settle(rows.commit(answerOf(child.settled), t.time.now()));
    await t.backend.idle();
    expect(child.hold.lost.aborted).toBe(false);
    const tree = child.fs.tree();
    expect(tree["/knowledge/a.md"]).toEndWith(" \u0000half");
    expect(tree["/knowledge/big.md"]).toEndWith(` ${"x".repeat(100)}`);
    const done = await parent();
    expect(answerOf(done.settled).changes?.knowledge).toEqual([
      { name: "a.md", text: "whole\n" },
      { name: "big.md", text: "small\n" },
    ]);
    done.settle(rows.commit(answerOf(done.settled), t.time.now()));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(rows.text("a.md")).toBe("whole\n");
    expect(t.fake.deletes).toEqual([]);
  });

  // the walk's lines as a real walk prints them when entries move under
  // it: each path's entry turned into its E line, or one added after
  // /knowledge for a name gone before it was listed
  const moving =
    (errors: Record<string, string>) =>
    (lines: string[]): string[] => {
      const out = lines.flatMap((line) => {
        const path = line.split(" ").at(-1)!;
        if (line.startsWith("WALK")) return [];
        if (path in errors) return [`E ${errors[path]} ${path}`];
        if (path !== "/knowledge") return [line];
        const gone = Object.keys(errors).filter(
          (at) => !lines.some((each) => each.endsWith(` ${at}`)),
        );
        return [line, ...gone.map((at) => `E ${errors[at]} ${at}`)];
      });
      const n = out.filter((line) => !line.startsWith("E ")).length;
      return [...out, `WALK done ${n}`];
    };

  test("beside a running command a name gone or a doc moving under the walk stays for a later save", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const { child, parent } = await besideParent(
      t,
      rows,
      "v",
      ({ fs }) => {
        fs.write("/knowledge/b.md", "b2\n");
        // sed -i's temporary file, renamed away, and a.md rewritten
        // while it was hashed
        fs.walkLines = moving({
          "/knowledge/sedAbc12": "ENOENT",
          "/knowledge/a.md": "ESTALE",
        });
      },
      {
        early: ({ fs }) => fs.write("/knowledge/a.md", "half"),
        late: ({ fs }) => fs.write("/knowledge/a.md", "whole\n"),
      },
    );
    expect(answerOf(child.settled)).toMatchObject({
      refused: null,
      changes: {
        knowledge: [
          { name: "b.md", text: "b2\n" },
          { name: "p-v.md", text: "v\n" },
        ],
      },
    });
    child.fs.walkLines = undefined;
    child.settle(rows.commit(answerOf(child.settled), t.time.now()));
    await t.backend.idle();
    expect(child.hold.lost.aborted).toBe(false);
    expect(child.fs.tree()["/knowledge/a.md"]).toEndWith(" half");
    const done = await parent();
    expect(answerOf(done.settled).changes?.knowledge).toEqual([
      { name: "a.md", text: "whole\n" },
    ]);
    done.settle(rows.commit(answerOf(done.settled), t.time.now()));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(rows.text("a.md")).toBe("whole\n");
    expect(t.fake.deletes).toEqual([]);
  });

  test("beside a running command a doc that moves or goes between the walk and the pull stays for a later save", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const { child, parent } = await besideParent(t, rows, "q", ({ fs }) => {
      fs.write("/knowledge/a.md", "mine\n");
      fs.write("/knowledge/b.md", "b2\n");
      fs.write("/knowledge/c.md", "c\n");
      // the parent's writes land once the walk listed the tree
      fs.walkLines = (lines) => {
        fs.write("/knowledge/a.md", "parent\n");
        fs.write("/knowledge/b.md", "b2\n", 0o600);
        fs.remove("/knowledge/c.md");
        fs.walkLines = undefined;
        return lines;
      };
    });
    expect(answerOf(child.settled)).toMatchObject({
      refused: null,
      changes: { knowledge: [{ name: "p-q.md", text: "q\n" }] },
    });
    child.settle(rows.commit(answerOf(child.settled), t.time.now()));
    await t.backend.idle();
    expect(child.hold.lost.aborted).toBe(false);
    expect(child.fs.tree()["/knowledge/a.md"]).toBe("644 0 parent\n");
    const done = await parent();
    expect(answerOf(done.settled).changes?.knowledge).toEqual([
      { name: "a.md", text: "parent\n" },
      { name: "b.md", text: "b2\n" },
    ]);
    done.settle(rows.commit(answerOf(done.settled), t.time.now()));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(rows.text("a.md")).toBe("parent\n");
    expect(t.fake.deletes).toEqual([]);
  });

  test("alone, a doc moving under the walk or before the pull saves nothing and recycles", async () => {
    for (const late of [false, true]) {
      const t = setup();
      const ran = await t.run(ROWS, ({ fs }) => {
        fs.write("/knowledge/a.md", "mine\n");
        fs.walkLines = late
          ? (lines) => {
              fs.write("/knowledge/a.md", "other\n");
              return lines;
            }
          : moving({ "/knowledge/a.md": "ESTALE" });
        return {};
      });
      const answer = answerOf(ran.settled);
      expect(answer.changes).toBeNull();
      expect(answer.refused).toContain("nothing was saved");
      ran.settle({ landed: false, why: "skipped" });
      expect(await t.settled(ran.hold)).not.toBe("idle");
    }
  });

  test("alone, a doc that is not text refuses the save and recycles", async () => {
    const t = setup();
    const ran = await t.run(ROWS, ({ fs }) => {
      fs.write("/knowledge/a.md", "\u0000half");
      return {};
    });
    expect(answerOf(ran.settled).refused).toContain("not a text");
    ran.settle({ landed: false, why: "skipped" });
    expect(await t.settled(ran.hold)).not.toBe("idle");
  });

  test("a docs-off command beside one with docs leaves /knowledge to it", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const { child, parent } = await besideParent(t, rows, "o", () => {}, {
      rows: { ...ROWS, docs: false },
    });
    const off = { ...ROWS, docs: false };
    const answer = answerOf(child.settled);
    expect(answer.refused).toBeNull();
    expect(answer.notice).not.toContain("/knowledge");
    child.settle(t.landed(off, answer));
    await t.backend.idle();
    expect(child.hold.lost.aborted).toBe(false);
    expect(child.fs.tree()["/knowledge/p-o.md"]).toMatch(/ o\n$/);
    const done = await parent();
    expect(answerOf(done.settled).changes?.knowledge).toEqual([
      { name: "p-o.md", text: "o\n" },
    ]);
    done.settle(rows.commit(answerOf(done.settled), t.time.now()));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(t.fake.deletes).toEqual([]);
  });

  test("an edit over a doc a sibling's put-back took from another chat refuses, and beside others puts back that doc alone", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    // a long command that read revision 1, and another beside it
    const held = (tag: string, edit: (call: CommandCall) => void) => {
      const started = gate();
      const release = gate();
      const ran = t.run(
        ROWS,
        async (call) => {
          started.open();
          await release.opened;
          edit(call);
          return {};
        },
        { command: tag, docs: rows.read },
      );
      return { started: started.opened, release: release.open, ran };
    };
    const long = held("long", ({ fs }) => {
      fs.write("/knowledge/a.md", "mine\n");
      fs.write("/knowledge/b.md", "b2\n");
    });
    await long.started;
    const other = held("other", () => {});
    await other.started;
    // another chat's revision 2, which a subagent's command reads and its
    // put-back brings into the sandbox
    rows.write("a.md", "theirs\n", 200);
    const child = await t.run(
      {
        knowledge: { "a.md": "theirs\n", "b.md": "b\n" },
        revisions: { "a.md": 2 },
        times: { "a.md": 200 },
        workspace: "child",
        subagent: true,
      },
      {},
      { command: "child", docs: rows.read },
    );
    child.settle(rows.commit(answerOf(child.settled), t.time.now()));
    await t.backend.idle();
    expect(child.fs.tree()["/knowledge/a.md"]).toBe("644 200 theirs\n");
    long.release();
    const done = await long.ran;
    expect(answerOf(done.settled)).toMatchObject({
      changes: null,
      refused:
        "a.md changed while the command ran, so it was put back; read it again and retry. Other changes stay in the sandbox for a later save.",
    });
    done.settle({ landed: false, why: "skipped" });
    await t.backend.idle();
    expect(done.hold.lost.aborted).toBe(false);
    expect(done.fs.tree()).toMatchObject({
      "/knowledge/a.md": "644 200 theirs\n",
      "/knowledge/b.md": expect.stringMatching(/ b2\n$/),
    });
    other.release();
    const last = await other.ran;
    expect(answerOf(last.settled).changes?.knowledge).toEqual([
      { name: "b.md", text: "b2\n" },
    ]);
    last.settle(rows.commit(answerOf(last.settled), t.time.now()));
    expect(await t.settled(last.hold)).toBe("idle");
    expect(rows.text("a.md")).toBe("theirs\n");
    expect(rows.text("b.md")).toBe("b2\n");
    expect(t.fake.deletes).toEqual([]);
  });

  test("an older command's edit over an imported doc refuses a save by one that pushed after the import", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const started = gate();
    const write = gate();
    const wrote = gate();
    const finish = gate();
    // a long command that read revision 1 and writes over it late
    const long = t.run(
      ROWS,
      async ({ fs }) => {
        started.open();
        await write.opened;
        fs.write("/knowledge/a.md", "mine\n");
        wrote.open();
        await finish.opened;
        return {};
      },
      { command: "long", docs: rows.read },
    );
    await started.opened;
    rows.write("a.md", "theirs\n", 200);
    const theirs = {
      knowledge: { "a.md": "theirs\n", "b.md": "b\n" },
      revisions: { "a.md": 2 },
      times: { "a.md": 200 },
    };
    const child = await t.run(
      { ...theirs, workspace: "child", subagent: true },
      {},
      { command: "child", docs: rows.read },
    );
    child.settle(rows.commit(answerOf(child.settled), t.time.now()));
    await t.backend.idle();
    // a command that pushed after the put-back took revision 2 in
    const ready = gate();
    const go = gate();
    const late = t.run(
      theirs,
      async () => {
        ready.open();
        await go.opened;
        return {};
      },
      { command: "late", docs: rows.read },
    );
    await ready.opened;
    write.open();
    await wrote.opened;
    go.open();
    const ended = await late;
    expect(answerOf(ended.settled)).toMatchObject({
      changes: null,
      refused:
        "a.md changed while the command ran, so it was put back; read it again and retry. Other changes stay in the sandbox for a later save.",
    });
    ended.settle({ landed: false, why: "skipped" });
    await t.backend.idle();
    expect(ended.fs.tree()["/knowledge/a.md"]).toBe("644 200 theirs\n");
    finish.open();
    const done = await long;
    expect(answerOf(done.settled).changes?.knowledge).toEqual([]);
    done.settle(rows.commit(answerOf(done.settled), t.time.now()));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(rows.text("a.md")).toBe("theirs\n");
    expect(t.fake.deletes).toEqual([]);
  });

  test("an edit a command left running makes after it ended still refuses over an import, until a fence", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    const held = (rows: Rows, tag: string) => {
      const started = gate();
      const release = gate();
      const ran = t.run(
        rows,
        async () => {
          started.open();
          await release.opened;
          return {};
        },
        { command: tag, docs: store(rows.knowledge ?? {}).read },
      );
      return { started: started.opened, release: release.open, ran };
    };
    // a command beside another ends unfenced, leaving its job running
    const other = held(ROWS, "other");
    await other.started;
    const left = await t.run(ROWS, {}, { command: "left", docs: rows.read });
    left.settle(rows.commit(answerOf(left.settled), t.time.now()));
    await t.backend.idle();
    // another chat's revision 2, which a subagent's put-back brings in
    rows.write("a.md", "theirs\n", 200);
    const theirs = {
      knowledge: { "a.md": "theirs\n", "b.md": "b\n" },
      revisions: { "a.md": 2 },
      times: { "a.md": 200 },
    };
    const child = await t.run(
      { ...theirs, workspace: "child", subagent: true },
      {},
      { command: "child", docs: rows.read },
    );
    child.settle(rows.commit(answerOf(child.settled), t.time.now()));
    await t.backend.idle();
    // every command still running pushed after the import
    const late = held(theirs, "late");
    await late.started;
    other.release();
    const first = await other.ran;
    first.settle({ landed: false, why: "skipped" });
    await t.backend.idle();
    // the job "left" started writes over what it read
    left.fs.write("/knowledge/a.md", "mine\n");
    late.release();
    const ended = await late.ran;
    expect(answerOf(ended.settled)).toMatchObject({
      changes: null,
      refused: "a.md changed while the command ran, read it again",
    });
    // its fence stopped what any command left running, so once its
    // save judged their writes, none of them is waited for
    ended.settle({ landed: false, why: "skipped" });
    expect(sharedOf(ended.hold.synced).pushes.size).toBe(0);
    expect(await t.settled(ended.hold)).not.toBe("idle");
    expect(rows.text("a.md")).toBe("theirs\n");
  });

  test("docs-off commands at once take /knowledge away while no command with docs runs", async () => {
    const t = setup();
    const first = await t.run(ROWS, {}, { command: "first" });
    first.settle(t.landed(ROWS, answerOf(first.settled)));
    expect(await t.settled(first.hold)).toBe("idle");
    const off = { ...ROWS, docs: false };
    const seen: string[][] = [];
    const docsOf = ({ fs }: CommandCall) =>
      Object.keys(fs.tree()).filter((path) => path.startsWith("/knowledge/"));
    // both hold the sandbox before either pushes
    const holdOf = async (workspace: string) =>
      (await t.leases.acquire(
        leaseCall(workspace),
        t.time.now() + 20_000,
        new AbortController().signal,
      )) as SandboxHold;
    const holdA = await holdOf("chat");
    const holdB = await holdOf("child");
    const started = gate();
    const release = gate();
    const a = t.run(
      off,
      async (call) => {
        seen.push(docsOf(call));
        started.open();
        await release.opened;
        return {};
      },
      { command: "a", hold: holdA },
    );
    await started.opened;
    const b = await t.run(
      { ...off, workspace: "child", subagent: true },
      (call) => {
        seen.push(docsOf(call));
        return {};
      },
      { command: "b", hold: holdB },
    );
    b.settle(t.landed(off, answerOf(b.settled)));
    release.open();
    const done = await a;
    done.settle(t.landed(off, answerOf(done.settled)));
    expect(await t.settled(done.hold)).toBe("idle");
    expect(seen).toEqual([[], []]);
  });

  test("a holder that never entered the sandbox leaves the command alone, so it fences", async () => {
    const t = setup();
    const idle = (await t.leases.acquire(
      leaseCall("child"),
      t.time.now() + 20_000,
      new AbortController().signal,
    )) as SandboxHold;
    const ran = await t.run(ROWS, ({ fs }) => {
      fs.write("/knowledge/c.md", "c\n");
      return {};
    });
    expect(ran.hold.sandbox).toBe(idle.sandbox);
    expect(ran.fs.calls).toContain("fence");
    ran.settle(t.landed(ROWS, answerOf(ran.settled)));
    await t.backend.idle();
    idle.release();
    expect(await t.settled(ran.hold)).toBe("idle");
  });

  test("a command waits for the sandbox's turns holding no process slot", async () => {
    const t = setup();
    const holdOf = async (workspace: string) =>
      (await t.leases.acquire(
        leaseCall(workspace),
        t.time.now() + 20_000,
        new AbortController().signal,
      )) as SandboxHold;
    const mine = await holdOf("chat");
    const other = await holdOf("child");
    const signal = new AbortController().signal;
    let pass = await other.turn(signal);
    const events: string[] = [];
    const ran = t.run(
      ROWS,
      async () => {
        events.push("run");
        // the save's turn is taken before the command ends
        pass = await other.turn(signal);
        return {};
      },
      {
        slot: {
          free: () => events.push("free"),
          take: async () => {
            events.push("take");
          },
        },
        hold: mine,
      },
    );
    await until(() => events.length > 0);
    await stays(() => events.join() === "free");
    pass();
    await until(() => events.includes("run"));
    await stays(() => events.join() === "free,run");
    pass();
    const done = await ran;
    expect(events).toEqual(["free", "run", "take"]);
    done.settle(t.landed(ROWS, answerOf(done.settled)));
    await t.backend.idle();
    other.release();
    expect(await t.settled(done.hold)).toBe("idle");
  });

  test("beside a running command a stopped one ends alone, and the sandbox goes after", async () => {
    for (const how of ["stop", "deadline"] as const) {
      const t = setup();
      const started = gate();
      const release = gate();
      const parent = t.run(
        ROWS,
        async () => {
          started.open();
          await release.opened;
          return {};
        },
        { command: "parent" },
      );
      await started.opened;
      const stop = new AbortController();
      const child = await t.run(
        { ...ROWS, workspace: "child", subagent: true },
        ({ signal }) => {
          stop.abort();
          return Promise.reject(signal.reason);
        },
        { command: "child", [how]: stop },
      );
      expect(child.settled).toMatchObject({
        ok: false,
        cause: how === "stop" ? "abort" : "deadline",
      });
      child.settle({ landed: false, why: "skipped" });
      await t.backend.idle();
      expect(child.hold.lost.aborted).toBe(false);
      expect(t.fake.deletes).toEqual([]);
      release.open();
      const done = await parent;
      expect(answerOf(done.settled).refused).toBeNull();
      done.settle(t.landed(ROWS, answerOf(done.settled)));
      // what the stopped command started may still run: the sandbox goes
      await until(() => t.fake.deletes.length === 1);
      expect(t.fake.deletes).toEqual([child.hold.sandbox]);
    }
  });

  test("a recycle stops the other commands in the sandbox, which end cleanly, and it goes once they let go", async () => {
    const t = setup();
    const started = gate();
    const parent = t.run(
      ROWS,
      ({ signal }) => {
        started.open();
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      },
      { command: "parent" },
    );
    await started.opened;
    const child = await t.run(
      { ...ROWS, workspace: "child", subagent: true },
      ({ fs }) => {
        fs.write("/uploads/a.txt", "mine\n");
        return {};
      },
      { command: "child" },
    );
    // a change under /uploads cannot be put back: the sandbox is recycled
    child.settle({ landed: false, why: "skipped" });
    const stopped = await parent;
    expect(stopped.settled).toMatchObject({ ok: false, cause: "error" });
    expect(!stopped.settled.ok && stopped.settled.error?.message).toBe(
      RECYCLED,
    );
    expect(t.fake.deletes).toEqual([]);
    stopped.settle({ landed: false, why: "skipped" });
    await until(() => t.fake.deletes.length === 1);
    expect(t.fake.deletes).toEqual([child.hold.sandbox]);
    // the next command makes a fresh one
    const next = await t.run(ROWS, {}, { command: "next" });
    expect(next.hold.sandbox).not.toBe(child.hold.sandbox);
    next.settle({ landed: false, why: "skipped" });
  });

  test("after another's save, a doc someone else changed refuses the save that changed it; one it left comes in", async () => {
    const t = setup();
    const rows = store(ROWS.knowledge);
    // the parent's command, with a child's command saved meanwhile
    const beside = async (edit: (call: CommandCall) => void) => {
      const started = gate();
      const release = gate();
      const parent = t.run(
        ROWS,
        async (call) => {
          started.open();
          await release.opened;
          edit(call);
          return {};
        },
        { command: "parent", docs: rows.read },
      );
      await started.opened;
      const child = await t.run(
        { ...ROWS, workspace: "child", subagent: true },
        {},
        { command: "child", docs: rows.read },
      );
      child.settle(rows.commit(answerOf(child.settled), t.time.now()));
      await t.backend.idle();
      release.open();
      return parent;
    };
    const clash = await beside(({ fs }) => {
      fs.write("/knowledge/a.md", "mine\n");
      rows.write("a.md", "theirs\n", 200);
    });
    expect(answerOf(clash.settled)).toMatchObject({
      changes: null,
      refused: "a.md changed while the command ran, read it again",
    });
    clash.settle({ landed: false, why: "skipped" });
    expect(await t.settled(clash.hold)).not.toBe("idle");
    // a fresh sandbox, the jobs' rows older than the store's
    const apart = await beside(({ fs }) => {
      fs.write("/knowledge/b.md", "mine\n");
      rows.write("a.md", "later\n", 300);
      rows.write("c.md", "new\n", 300);
    });
    expect(answerOf(apart.settled).changes?.knowledge).toEqual([
      { name: "b.md", text: "mine\n" },
    ]);
    apart.settle(rows.commit(answerOf(apart.settled), 400));
    expect(await t.settled(apart.hold)).toBe("idle");
    expect(apart.fs.tree()).toMatchObject({
      "/knowledge/a.md": "644 300 later\n",
      "/knowledge/b.md": "644 400 mine\n",
      "/knowledge/c.md": "644 300 new\n",
    });
  });

  test("a subagent's kept files sit beside its parent's while it runs, and go after", async () => {
    const t = setup();
    const own = { "/mcp/0001-read/x.txt": "x" };
    const started = gate();
    const release = gate();
    const parent = t.run(
      { ...ROWS, kept: own },
      async () => {
        started.open();
        await release.opened;
        return {};
      },
      { command: "parent" },
    );
    await started.opened;
    const child = await t.run(
      {
        ...ROWS,
        workspace: "child",
        subagent: true,
        kept: { "/mcp/0002-search/y.txt": "y" },
      },
      {},
      { command: "child" },
    );
    expect(answerOf(child.settled).notice).toBe("");
    expect(
      Object.keys(child.fs.tree()).filter((path) => path.startsWith("/mcp/")),
    ).toEqual([
      "/mcp/0001-read",
      "/mcp/0001-read/x.txt",
      "/mcp/0002-search",
      "/mcp/0002-search/y.txt",
    ]);
    child.settle(t.landed(ROWS, answerOf(child.settled)));
    await t.backend.idle();
    release.open();
    const done = await parent;
    expect(answerOf(done.settled).notice).toBe("");
    done.settle(t.landed(ROWS, answerOf(done.settled)));
    expect(await t.settled(done.hold)).toBe("idle");
    const next = await t.run({ ...ROWS, kept: own }, {}, { command: "next" });
    expect(
      Object.keys(next.fs.tree()).filter((path) => path.startsWith("/mcp/")),
    ).toEqual(["/mcp/0001-read", "/mcp/0001-read/x.txt"]);
    next.settle(t.landed(ROWS, answerOf(next.settled)));
  });
});

describe("a lease held by several commands", () => {
  const call = (workspace: string): ShellCall => ({
    projectId: "project",
    workspace: { id: workspace, sessionId: workspace },
    root: "chat",
    sendId: "send",
    subagent: workspace !== "chat",
    repos: [],
    repoFileBytes: 0,
    network: false,
    credentials: [],
  });

  test("goes idle at the last release, and the idle clock starts there", async () => {
    const t = setup({ sandboxIdleMinutes: 5 });
    const acquire = async (workspace: string) => {
      const got = await t.leases.acquire(
        call(workspace),
        t.time.now() + 20_000,
        new AbortController().signal,
      );
      if (got === "busy") throw new Error("busy");
      return got;
    };
    const parent = await acquire("chat");
    const child = await acquire("child");
    expect(child.sandbox).toBe(parent.sandbox);
    parent.release();
    const state = () => t.leases.rows()[0]?.state;
    expect(state()).toBe("leased");
    t.time.advance(4 * MINUTE_MS);
    child.release();
    expect(state()).toBe("idle");
    t.time.advance(5 * MINUTE_MS - 1);
    expect(state()).toBe("idle");
    t.time.advance(1);
    await until(() => t.leases.rows().length === 0);
    expect(t.fake.deletes).toEqual([parent.sandbox]);
  });

  test("two first commands at once make one sandbox, the second joining when it is made", async () => {
    const t = setup();
    const signal = new AbortController().signal;
    const [parent, child] = await Promise.all([
      t.leases.acquire(call("chat"), t.time.now() + 20_000, signal),
      t.leases.acquire(call("child"), t.time.now() + 20_000, signal),
    ]);
    if (parent === "busy" || child === "busy") throw new Error("busy");
    expect(child.sandbox).toBe(parent.sandbox);
    expect(t.fake.creates).toHaveLength(1);
    parent.release();
    child.release();
    expect(t.leases.rows()).toMatchObject([{ state: "idle" }]);
  });

  test("a command waiting for the network's turn when a sibling recycles goes on to a fresh sandbox", async () => {
    const t = setup();
    const signal = new AbortController().signal;
    const parent = await t.leases.acquire(
      call("chat"),
      t.time.now() + 20_000,
      signal,
    );
    if (parent === "busy") throw new Error("busy");
    // the parent's save holds the turn
    const pass = await parent.turn(signal);
    const child = t.leases.acquire(
      call("child"),
      t.time.now() + 20_000,
      signal,
    );
    await stays(() => t.fake.creates.length === 1);
    parent.recycle("discard");
    const fresh = await child;
    if (fresh === "busy") throw new Error("busy");
    expect(fresh.sandbox).not.toBe(parent.sandbox);
    expect(fresh.lost.aborted).toBe(false);
    expect(t.fake.deletes).toEqual([parent.sandbox]);
    pass();
    fresh.release();
  });

  test("a network setup that fails beside another command fails only its own, and the sandbox goes after", async () => {
    const t = setup();
    const signal = new AbortController().signal;
    const parent = await t.leases.acquire(
      call("chat"),
      t.time.now() + 20_000,
      signal,
    );
    if (parent === "busy") throw new Error("busy");
    t.fake.fail("globalPolicy");
    const error = await rejection(
      t.leases.acquire(call("child"), t.time.now() + 20_000, signal),
    );
    expect(error.message).toBe("the sandbox network could not be set up");
    t.fake.unfail("globalPolicy");
    expect(parent.lost.aborted).toBe(false);
    expect(t.leases.rows()).toMatchObject([{ state: "leased" }]);
    expect(t.fake.deletes).toEqual([]);
    parent.release();
    await until(() => t.fake.deletes.length === 1);
    expect(t.fake.deletes).toEqual([parent.sandbox]);
  });

  test("a doomed one is never joined: a new command waits for its delete", async () => {
    const t = setup();
    const acquire = (workspace: string) =>
      t.leases.acquire(
        call(workspace),
        t.time.now() + 20_000,
        new AbortController().signal,
      );
    const parent = await acquire("chat");
    if (parent === "busy") throw new Error("busy");
    const child = await acquire("child");
    if (child === "busy") throw new Error("busy");
    child.recycle("discard");
    expect(parent.lost.aborted).toBe(true);
    const next = acquire("other");
    await stays(() => t.fake.creates.length === 1);
    parent.release();
    const made = await next;
    if (made === "busy") throw new Error("busy");
    expect(made.sandbox).not.toBe(parent.sandbox);
    expect(t.fake.deletes).toEqual([parent.sandbox]);
  });
});
