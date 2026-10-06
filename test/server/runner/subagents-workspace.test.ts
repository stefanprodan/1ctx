// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's workspace: the parent's /tmp copied in, what it added or
// changed copied back under /tmp/<folder>/ within the caps, the parent's
// uploads read, /knowledge and /uploads read-only, and no open.

import { describe, expect, test } from "bun:test";
import { copyBack, copyIn } from "../../../src/server/bash/handoff.ts";
import { checkOpened } from "../../../src/server/bash/open.ts";
import { ScratchStore } from "../../../src/server/bash/scratch.ts";
import { READ_ONLY_TO_SUBAGENT } from "../../../src/server/bash/tree.ts";
import { transact } from "../../../src/server/db/index.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { type ChatApp, startChat, waitScript } from "../../helpers/chat.ts";
import {
  bashCall,
  childrenOf,
  delegateCall,
  isChild,
  lastResult,
  scratchLeft,
  settled,
  subagentApp,
} from "../../helpers/subagents.ts";
import { stage, start } from "./uploads-helpers.ts";

const scratchOf = (chat: ChatApp, sessionId: string) =>
  Object.fromEntries(
    new ScratchStore(chat.app.db)
      .read(sessionId)
      .entries.map((file) => [file.path, Buffer.from(file.data).toString()]),
  );

describe("a subagent's /tmp", () => {
  test("starts as the parent's and what it adds or changes comes back under its folder", async () => {
    const chat = await subagentApp();
    try {
      const { script, sessionId } = await startChat(chat, "write a report");
      script.toolRound([
        bashCall(
          "b1",
          "printf seed > /tmp/seed.txt; printf keep > /tmp/keep.txt",
        ),
      ]);
      script.end();
      const second = await waitScript(chat.scripted, 2);
      second.toolRound([delegateCall("d1", "Write the report.")]);
      second.end();
      const child = await waitScript(chat.scripted, 3);
      expect(isChild(child)).toBe(true);
      child.toolRound([
        bashCall(
          "c1",
          "cat /tmp/seed.txt; pwd; printf report > /tmp/report.md; printf changed > /tmp/seed.txt",
        ),
      ]);
      child.end();
      const answer = await waitScript(chat.scripted, 4);
      expect(lastResult(answer)).toContain("seed");
      expect(lastResult(answer)).toContain("/tmp\n");
      answer.reply("Wrote /tmp/report.md.");
      const back = await waitScript(chat.scripted, 5);
      expect(lastResult(back)).toBe(
        "Wrote /tmp/report.md.\n\nFiles in /tmp/sub-1/:\n/tmp/sub-1/report.md\n/tmp/sub-1/seed.txt",
      );
      back.reply("done");
      await settled(chat, sessionId);
      expect(scratchOf(chat, sessionId)).toEqual({
        "keep.txt": "keep",
        "seed.txt": "seed",
        "sub-1/report.md": "report",
        "sub-1/seed.txt": "changed",
      });
      const [childId] = childrenOf(chat, sessionId);
      expect(scratchLeft(chat, childId!)).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a change to /knowledge or /uploads saves nothing, and open is not there", async () => {
    const chat = await subagentApp();
    try {
      const { script, sessionId } = await startChat(chat);
      script.toolRound([delegateCall("d1", "Try to write.")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      child.toolRound([
        bashCall("c1", "printf x > /knowledge/new.md; printf y > /tmp/y.txt"),
        bashCall("c2", "printf z > /uploads/z.txt; printf y > /tmp/w.txt"),
        bashCall("c3", "printf q > /tmp/q.html; open /tmp/q.html"),
      ]);
      child.end();
      const next = await waitScript(chat.scripted, 3);
      const results = next.body.messages as { role: string; content: string }[];
      const tools = results.filter((m) => m.role === "tool");
      expect(tools[0]!.content).toContain(
        `nothing saved: ${READ_ONLY_TO_SUBAGENT}`,
      );
      expect(tools[1]!.content).toContain(
        `nothing saved: ${READ_ONLY_TO_SUBAGENT}`,
      );
      expect(tools[2]!.content).toContain("open: command not found");
      next.reply("could not");
      await waitScript(chat.scripted, 4);
      chat.scripted.scripts[3]!.reply("done");
      await settled(chat, sessionId);
      const [childId] = childrenOf(chat, sessionId);
      expect(scratchLeft(chat, childId!)).toBe(0);
      expect(Object.keys(scratchOf(chat, sessionId))).toEqual(["sub-1/q.html"]);
      expect(
        chat.app.db
          .query(
            "select count(*) as n from knowledge_files where name = 'new.md'",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(
        chat.app.db.query("select count(*) as n from opened_files").get(),
      ).toEqual({ n: 0 });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("reads its parent's uploads", async () => {
    const chat = await subagentApp();
    try {
      const upload = await stage(chat, "notes.txt", "from the user");
      const { script, sessionId } = await start(chat, [upload.id]);
      script.toolRound([delegateCall("d1", "Read the notes.")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      child.toolRound([bashCall("c1", "cat /uploads/notes.txt")]);
      child.end();
      const next = await waitScript(chat.scripted, 3);
      expect(lastResult(next)).toContain("from the user");
      next.reply("read");
      await waitScript(chat.scripted, 4);
      chat.scripted.scripts[3]!.reply("done");
      await settled(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the server refuses an opened record from a subagent's worker", () => {
    const record = {
      path: "/tmp/a.md",
      kind: "markdown" as const,
      language: null,
      bytes: 1,
      lines: 1,
      title: "a.md",
      text: "a",
    };
    expect(() =>
      checkOpened([record as never], {
        knowledgeFileBytes: 1000,
        visuals: true,
        knowledge: true,
        open: false,
      }),
    ).toThrow("out of protocol");
  });
});

describe("copying back", () => {
  test("stops at the parent's caps and names what did not fit", async () => {
    const chat = await subagentApp();
    try {
      const parent = chat.app.sessions.create({
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        title: "p",
        now: chat.app.now.value,
      });
      const child = chat.app.sessions.create({
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        title: "c",
        now: chat.app.now.value,
      });
      const store = new ScratchStore(chat.app.db);
      const bytes = (text: string) => new TextEncoder().encode(text);
      transact(chat.app.db, () => {
        store.write(
          parent.id,
          0,
          {
            written: [{ path: "old.txt", data: bytes("old"), mode: 0o644 }],
            removed: [],
            cwd: "/tmp",
          },
          0,
        );
        return { result: undefined };
      });
      const baseline = copyIn(chat.app.db, store, parent.id, child.id, 1);
      expect(scratchOf(chat, child.id)).toEqual({ "old.txt": "old" });
      transact(chat.app.db, () => {
        store.write(
          child.id,
          1,
          {
            written: [
              { path: "a.txt", data: bytes("a"), mode: 0o644 },
              { path: "b.txt", data: bytes("b"), mode: 0o644 },
            ],
            removed: [],
            cwd: "/tmp",
          },
          2,
        );
        return { result: undefined };
      });
      const returned = await copyBack(
        {
          db: chat.app.db,
          store,
          current: () => ({ ...DEFAULT_LIMITS, scratchFiles: 2 }),
        },
        child.id,
        parent.id,
        new Set(),
        baseline,
        3,
      );
      expect(returned).toEqual({
        folder: "sub-1",
        copied: ["/tmp/sub-1/a.txt"],
        left: ["b.txt"],
      });
      expect(scratchLeft(chat, child.id)).toBe(0);
      expect(scratchOf(chat, parent.id)).toEqual({
        "old.txt": "old",
        "sub-1/a.txt": "a",
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("picks its folder at the end, past what the parent and siblings wrote meanwhile", async () => {
    const chat = await subagentApp();
    try {
      const session = (title: string) =>
        chat.app.sessions.create({
          projectId: chat.projectId,
          ownerId: chat.memberId,
          agentId: chat.agentId,
          title,
          now: chat.app.now.value,
        }).id;
      const parent = session("p");
      const child = session("c");
      const store = new ScratchStore(chat.app.db);
      const bytes = (text: string) => new TextEncoder().encode(text);
      const write = (id: string, path: string, text: string) =>
        transact(chat.app.db, () => {
          const at = store.read(id).revision;
          store.write(
            id,
            at,
            {
              written: [{ path, data: bytes(text), mode: 0o644 }],
              removed: [],
              cwd: "/tmp",
            },
            0,
          );
          return { result: undefined };
        });
      const baseline = copyIn(chat.app.db, store, parent, child, 1);
      // the parent's own command, while its child ran
      write(parent, "sub-1/report.md", "the parent's");
      write(child, "report.md", "the child's");
      const taken = new Set(["sub-2"]);
      const returned = await copyBack(
        { db: chat.app.db, store, current: () => DEFAULT_LIMITS },
        child,
        parent,
        taken,
        baseline,
        3,
      );
      expect(returned).toEqual({
        folder: "sub-3",
        copied: ["/tmp/sub-3/report.md"],
        left: [],
      });
      expect([...taken]).toEqual(["sub-2", "sub-3"]);
      expect(scratchOf(chat, parent)).toEqual({
        "sub-1/report.md": "the parent's",
        "sub-3/report.md": "the child's",
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});
