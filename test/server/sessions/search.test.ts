// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's sessions listed and searched by words: children and
// archived sessions included, only what a transcript shows read, paged
// by a cursor.

import { describe, expect, test } from "bun:test";
import type { Db } from "../../../src/server/db/index.ts";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import {
  chatMarkdownParts,
  SessionStore,
  type UsagePort,
} from "../../../src/server/sessions/index.ts";
import {
  listSessionsOf,
  searchSessions,
} from "../../../src/server/sessions/search.ts";
import { SEARCH_PAGE } from "../../../src/shared/api/knowledge.ts";
import { memoryDb } from "../../helpers/db.ts";

const noUsage: UsagePort = {
  latest: () => null,
  latestFor: () => new Map(),
};

// work is a round's text before its calls; memory is the answer of a
// run's memory phase, round 2
type Kind = "user" | "reply" | "work" | "memory" | "tool" | "summary";

function seeded() {
  const db = memoryDb();
  db.exec(`
    insert into users (id, username, full_name, email, role, password_hash,
      created_at)
    values ('u', 'ana', 'Ana', 'ana@example.com', 'member', 'x', 0);
    insert into projects (id, kind, name, owner_id, created_at)
    values ('p', 'team', 'team-one', 'u', 0),
      ('q', 'team', 'team-two', 'u', 0);
    insert into providers (id, name, wire, base_url, created_at)
    values ('pr', 'prov', 'openai-compatible', 'http://x', 0);
    insert into agents (id, name, provider_id, model, model_name, created_at)
    values ('a', 'writer', 'pr', 'm', 'M', 0);
    insert into automations (id, project_id, owner_id, agent_id, name,
      instructions, schedule, tz, retention_days, next_at, created_at,
      updated_at)
    values ('au', 'p', 'u', 'a', 'digest', 'go', '0 * * * *', 'UTC', 30, 1,
      0, 0);
  `);
  const store = new SessionStore(db, noUsage, {
    drop() {},
    held: () => new Set(),
  });
  let seq = 0;
  const add = (
    fields: {
      project?: string;
      at?: number;
      title?: string;
      run?: boolean;
      parent?: { sessionId: string; messageId: string };
      texts?: [Kind, string][];
    } = {},
  ) => {
    const id = store.create({
      projectId: fields.project ?? "p",
      ownerId: "u",
      agentId: "a",
      title: fields.title ?? "chat",
      status: "done",
      now: fields.at ?? 0,
      parent: fields.parent ?? null,
      ...(fields.run
        ? { origin: "automation" as const, automationId: "au" }
        : {}),
    }).id;
    const send = `${id}-s`;
    db.query(
      `insert into sends (id, session_id, kind, user_id, agent_id,
         provider_id, provider_name, model, status, first_message_id,
         started_at, finished_at)
       values (?, ?, 'chat', 'u', 'a', 'pr', 'prov', 'm', 'done', ?, 0, 0)`,
    ).run(send, id, `${id}-m1`);
    if (fields.texts?.some(([kind]) => kind === "memory")) {
      db.query("update sends set memory_round = 2 where id = ?").run(send);
    }
    const messages: string[] = [];
    for (const [given, content] of fields.texts ?? []) {
      seq++;
      const kind = given === "work" || given === "memory" ? "reply" : given;
      const slot =
        given === "work" ? "work" : kind === "reply" ? "answer" : null;
      const messageId = `${id}-m${messages.length + 1}`;
      messages.push(messageId);
      db.query(
        `insert into messages (id, session_id, seq, kind, send_id, round,
           slot, user_id, tool_call_id, tool_name, content, status,
           created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', 0)`,
      ).run(
        messageId,
        id,
        seq,
        kind,
        send,
        given === "memory" ? 2 : 1,
        slot,
        kind === "user" ? "u" : null,
        kind === "tool" ? `c${seq}` : null,
        kind === "tool" ? "bash" : null,
        content,
      );
    }
    return { id, messages };
  };
  return { db, store, add };
}

// every page of a search, following next until it is null
function allPages(db: Db, q: string, budget?: number): string[][] {
  const out: string[][] = [];
  let after: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page = searchSessions(db, "p", q, after, budget);
    out.push(page.hits.map((hit) => hit.id));
    if (page.next === null) return out;
    after = page.next;
  }
  throw new Error("pages never ended");
}

describe("session search", () => {
  test("a session matches when its messages together hold every word", () => {
    const { db, add } = seeded();
    const both = add({
      at: 2,
      title: "the plan",
      texts: [
        ["user", "Read the plan\nplease"],
        ["reply", "done\nExternal tasks are next"],
      ],
    });
    add({ at: 3, texts: [["user", "the plan, external work"]] });
    const page = searchSessions(db, "p", "plan external TASKS", null);
    expect(page).toEqual({
      hits: [
        {
          id: both.id,
          title: "the plan",
          kind: "chat",
          parentSessionId: null,
          lastActivityAt: 2,
          count: 2,
          lines: [
            {
              messageId: both.messages[0]!,
              line: 1,
              text: "Read the plan",
              cutStart: false,
              cutEnd: false,
            },
            {
              messageId: both.messages[1]!,
              line: 2,
              text: "External tasks are next",
              cutStart: false,
              cutEnd: false,
            },
          ],
        },
      ],
      next: null,
    });
    expect(searchSessions(db, "p", '"plan external"', null).hits).toEqual([]);
  });

  test("reads only what a transcript shows, so every hit can be read", () => {
    const { db, store, add } = seeded();
    add({
      at: 1,
      texts: [
        ["user", "look"],
        ["work", "let me check the quokkaplan first"],
        ["tool", "ok"],
        ["reply", "all good"],
      ],
    });
    add({
      at: 2,
      run: true,
      texts: [
        ["user", "go"],
        ["work", "checking"],
        ["memory", "noted the quokkaplan"],
      ],
    });
    const shown = add({
      at: 3,
      texts: [
        ["user", "the quokkaplan"],
        ["work", "quokkaplan work"],
        ["reply", "the quokkaplan holds"],
      ],
    });
    const hits = searchSessions(db, "p", "quokkaplan", null).hits;
    expect(hits.map((hit) => hit.id)).toEqual([shown.id]);
    expect(hits[0]!.lines.map((line) => line.messageId)).toEqual([
      shown.messages[0]!,
      shown.messages[2]!,
    ]);
    const parts = chatMarkdownParts(
      "chat",
      store.exportRows(shown.id),
      "UTC",
    ).map((part) => part.messageId);
    for (const line of hits[0]!.lines) {
      expect(parts).toContain(line.messageId);
    }
  });

  test("tool rows and summaries are never read", () => {
    const { db, add } = seeded();
    add({
      texts: [
        ["user", "look"],
        ["tool", "needle in a tool"],
        ["summary", "needle in a summary"],
      ],
    });
    expect(searchSessions(db, "p", "needle", null).hits).toEqual([]);
  });

  test("children carry their parent, archived sessions and runs are found", () => {
    const { db, add } = seeded();
    const root = add({ at: 1, texts: [["user", "start the needle hunt"]] });
    const child = add({
      at: 2,
      parent: { sessionId: root.id, messageId: root.messages[0]! },
      texts: [["reply", "found the needle"]],
    });
    const run = add({ at: 3, run: true, texts: [["reply", "needle report"]] });
    db.query(
      "update sessions set archived_at = 5, archived_reason = 'idle' where id = ?",
    ).run(root.id);
    const hits = searchSessions(db, "p", "needle", null).hits;
    expect(hits.map((hit) => [hit.id, hit.kind, hit.parentSessionId])).toEqual([
      [run.id, "run", null],
      [child.id, "chat", root.id],
      [root.id, "chat", null],
    ]);
  });

  test("another project's sessions never appear", () => {
    const { db, add } = seeded();
    add({ project: "q", texts: [["user", "needle"]] });
    const mine = add({ texts: [["user", "needle"]] });
    expect(
      searchSessions(db, "p", "needle", null).hits.map((hit) => hit.id),
    ).toEqual([mine.id]);
    expect(
      listSessionsOf(db, "p", null, null).sessions.map((row) => row.id),
    ).toEqual([mine.id]);
  });

  test("pages by page size, newest first, with no skip or repeat", () => {
    const { db, add } = seeded();
    const ids: string[] = [];
    for (let i = 0; i < 2 * SEARCH_PAGE + 5; i++) {
      const at = Math.floor(i / 3);
      ids.push(add({ at, texts: [["user", `needle ${i}`]] }).id);
      add({ at, texts: [["user", "nothing"]] });
    }
    const order = listSessionsOf(db, "p", null, null, 1000).sessions.map(
      (row) => row.id,
    );
    const pages = allPages(db, "needle");
    expect(pages.map((page) => page.length)).toEqual([
      SEARCH_PAGE,
      SEARCH_PAGE,
      5,
    ]);
    expect(pages.flat()).toEqual(order.filter((id) => ids.includes(id)));
  });

  test("a spent budget ends the page early, one session a page at least", () => {
    const { db, add } = seeded();
    const ids: string[] = [];
    // 16 bytes each
    for (let i = 0; i < 6; i++) {
      ids.push(
        add({
          at: 10 - i,
          texts: [
            ["user", "0123456789 hit\n"],
            ["reply", "x"],
          ],
        }).id,
      );
    }
    const pages = allPages(db, "hit", 40);
    expect(pages).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
    const tiny = allPages(db, "hit", 0);
    expect(tiny).toEqual(ids.map((id) => [id]));
  });

  test("refuses a query with no word and a bad cursor", () => {
    const { db } = seeded();
    expect(() => searchSessions(db, "p", '""', null)).toThrow(
      new BadRequest("q must hold a word"),
    );
    expect(() => searchSessions(db, "p", "x", "nope")).toThrow(
      new BadRequest("invalid cursor"),
    );
  });
});

describe("session list", () => {
  test("lists every session newest first with who and what", () => {
    const { db, add } = seeded();
    const root = add({ at: 1, title: "root", texts: [["user", "go"]] });
    const child = add({
      at: 2,
      title: "a task",
      parent: { sessionId: root.id, messageId: root.messages[0]! },
    });
    const run = add({ at: 3, title: "digest", run: true });
    db.query(
      "update sessions set archived_at = 5, archived_reason = 'idle' where id = ?",
    ).run(root.id);
    expect(listSessionsOf(db, "p", null, null)).toEqual({
      sessions: [
        {
          id: run.id,
          title: "digest",
          kind: "run",
          agent: "writer",
          owner: "ana",
          parentSessionId: null,
          lastActivityAt: 3,
          archived: false,
        },
        {
          id: child.id,
          title: "a task",
          kind: "chat",
          agent: "writer",
          owner: "ana",
          parentSessionId: root.id,
          lastActivityAt: 2,
          archived: false,
        },
        {
          id: root.id,
          title: "root",
          kind: "chat",
          agent: "writer",
          owner: "ana",
          parentSessionId: null,
          lastActivityAt: 1,
          archived: true,
        },
      ],
      next: null,
    });
  });

  test("pages with ties and keeps those active since a time", () => {
    const { db, add } = seeded();
    for (let i = 0; i < 25; i++) add({ at: Math.floor(i / 4) });
    const all = listSessionsOf(db, "p", null, null, 1000).sessions.map(
      (row) => row.id,
    );
    const pages: string[][] = [];
    let after: string | null = null;
    do {
      const page = listSessionsOf(db, "p", null, after, 10);
      pages.push(page.sessions.map((row) => row.id));
      after = page.next;
    } while (after !== null);
    expect(pages.map((page) => page.length)).toEqual([10, 10, 5]);
    expect(pages.flat()).toEqual(all);
    const since = listSessionsOf(db, "p", 5, null).sessions;
    expect(since.map((row) => row.lastActivityAt)).toEqual([6, 5, 5, 5, 5]);
    expect(listSessionsOf(db, "p", 7, null)).toEqual({
      sessions: [],
      next: null,
    });
  });
});
