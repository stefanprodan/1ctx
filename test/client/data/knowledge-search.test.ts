// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The knowledge search: asked after a pause in typing, one request out
// at a time, an answer to a query no longer wanted dropped, and Show
// more paging the files.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  answered,
  asking,
  clearSearch,
  loadMoreSearch,
  nextPage,
  SEARCH_IDLE,
  SEARCH_PAUSE_MS,
  searchKnowledge,
  searchOf,
  searchQuery,
} from "../../../src/client/data/knowledge-search.ts";
import { me } from "../../../src/client/data/me.ts";
import type { KnowledgeSearchResponse } from "../../../src/shared/api/knowledge.ts";
import type {
  KnowledgeFile,
  KnowledgeSearchHit,
} from "../../../src/shared/contracts/knowledge.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const reader: Me = {
  id: "u1",
  username: "reader",
  fullName: "Reader",
  role: "member",
  mustChangePassword: false,
};

function file(id: string): KnowledgeFile {
  return {
    id,
    projectId: "p1",
    name: `${id}.md`,
    kind: "md",
    bytes: 1,
    lines: 1,
    tokens: 1,
    revision: 1,
    author: {
      kind: "user",
      id: "u1",
      name: "reader",
      sessionId: null,
      origin: null,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

const hit = (id: string): KnowledgeSearchHit => ({
  file: file(id),
  count: 1,
  lines: [{ line: 1, text: "deploy", cutStart: false, cutEnd: false }],
});

const response = (
  changes: Partial<KnowledgeSearchResponse> = {},
): KnowledgeSearchResponse => ({
  names: [],
  namesTotal: 0,
  files: [],
  next: null,
  ...changes,
});

describe("the search's shapes", () => {
  test.serial("a query is trimmed, cut, and asked from two characters", () => {
    expect(searchQuery(" d ")).toBeNull();
    expect(searchQuery(" de ")).toBe("de");
    expect(searchQuery("x".repeat(120))).toHaveLength(100);
  });

  test.serial("a new query keeps the last rows while it loads", () => {
    const held = answered("dep", response({ files: [hit("a")] }));
    const next = asking(held, "depl");
    expect(next.state).toBe("loading");
    expect(next.q).toBe("depl");
    expect(next.files).toEqual(held.files);
  });

  test.serial("a later page adds its files once", () => {
    const held = answered("dep", response({ files: [hit("a")], next: "a.md" }));
    const next = nextPage(held, response({ files: [hit("a"), hit("b")] }));
    expect(next.files.map((h) => h.file.id)).toEqual(["a", "b"]);
    expect(next.next).toBeNull();
  });
});

const realFetch = globalThis.fetch;
let asked: string[];
let reply: (url: URL) => Promise<KnowledgeSearchResponse>;
const pause = () =>
  new Promise((resolve) => setTimeout(resolve, SEARCH_PAUSE_MS + 30));

beforeEach(() => {
  me.value = null;
  me.value = reader;
  asked = [];
  reply = async () => response();
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input, "http://x");
    asked.push(`${url.searchParams.get("q")}|${url.searchParams.get("after")}`);
    return new Response(JSON.stringify(await reply(url)));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the search", () => {
  test.serial("typing asks once, after the pause", async () => {
    searchKnowledge("p1", "de");
    searchKnowledge("p1", "dep");
    searchKnowledge("p1", "depl");
    expect(searchOf("p1").state).toBe("loading");
    expect(asked).toEqual([]);
    reply = async () => response({ files: [hit("a")], next: "a.md" });
    await pause();
    expect(asked).toEqual(["depl|null"]);
    expect(searchOf("p1").state).toBe("done");
    expect(searchOf("p1").files).toHaveLength(1);
  });

  test.serial(
    "a query typed while one is out waits, and the old answer goes",
    async () => {
      let give: (r: KnowledgeSearchResponse) => void = () => {};
      reply = () =>
        new Promise((resolve) => {
          give = resolve;
        });
      searchKnowledge("p1", "old");
      await pause();
      expect(asked).toEqual(["old|null"]);
      searchKnowledge("p1", "new");
      await pause();
      // the server scans one search at a time: nothing more went out
      expect(asked).toEqual(["old|null"]);
      const first = give;
      reply = async () => response({ files: [hit("n")] });
      first(response({ files: [hit("o")] }));
      await pause();
      expect(asked).toEqual(["old|null", "new|null"]);
      expect(searchOf("p1").q).toBe("new");
      expect(searchOf("p1").files.map((h) => h.file.id)).toEqual(["n"]);
    },
  );

  test.serial("a short query clears the search", async () => {
    searchKnowledge("p1", "dep");
    searchKnowledge("p1", "d");
    await pause();
    expect(asked).toEqual([]);
    expect(searchOf("p1")).toBe(SEARCH_IDLE);
  });

  test.serial("Show more asks after the last name held", async () => {
    reply = async () => response({ files: [hit("a")], next: "a.md" });
    searchKnowledge("p1", "dep");
    await pause();
    reply = async () => response({ files: [hit("b")] });
    await loadMoreSearch("p1");
    expect(asked).toEqual(["dep|null", "dep|a.md"]);
    expect(searchOf("p1").files.map((h) => h.file.id)).toEqual(["a", "b"]);
    expect(searchOf("p1").next).toBeNull();
  });

  test.serial(
    "a failure keeps the words until the search is cleared",
    async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: "busy" }), {
          status: 429,
        })) as unknown as typeof fetch;
      searchKnowledge("p1", "dep");
      await pause();
      expect(searchOf("p1").state).toBe("failed");
      expect(searchOf("p1").failure).toEqual({ words: "busy", status: 429 });
      clearSearch("p1");
      expect(searchOf("p1")).toBe(SEARCH_IDLE);
    },
  );

  test.serial("another user starts with none", async () => {
    searchKnowledge("p1", "dep");
    await pause();
    me.value = { ...reader, id: "u2" };
    expect(searchOf("p1")).toBe(SEARCH_IDLE);
  });

  test.serial(
    "a user change with a search out drops its answer and waits on nothing",
    async () => {
      let give: (r: KnowledgeSearchResponse) => void = () => {};
      reply = () =>
        new Promise((resolve) => {
          give = resolve;
        });
      searchKnowledge("p1", "old");
      await pause();
      const first = give;
      me.value = { ...reader, id: "u2" };
      reply = async () => response({ files: [hit("n")] });
      searchKnowledge("p1", "new");
      await pause();
      // the new user's search went out while the old one was still out
      expect(asked).toEqual(["old|null", "new|null"]);
      expect(searchOf("p1").files.map((h) => h.file.id)).toEqual(["n"]);
      first(response({ files: [hit("o")] }));
      await pause();
      expect(searchOf("p1").q).toBe("new");
      expect(searchOf("p1").files.map((h) => h.file.id)).toEqual(["n"]);
    },
  );

  test.serial(
    "a Show more waiting behind a request is dropped once overtaken",
    async () => {
      reply = async () => response({ files: [hit("a")], next: "a.md" });
      searchKnowledge("p1", "dep");
      await pause();
      // hold the flight with another project's search
      let give: (r: KnowledgeSearchResponse) => void = () => {};
      reply = () =>
        new Promise((resolve) => {
          give = resolve;
        });
      searchKnowledge("p2", "other");
      await pause();
      const more = loadMoreSearch("p1");
      searchKnowledge("p1", "depl");
      reply = async () => response({ files: [hit("z")] });
      give(response());
      await more;
      await pause();
      expect(asked).toEqual(["dep|null", "other|null", "depl|null"]);
      expect(searchOf("p1").files.map((h) => h.file.id)).toEqual(["z"]);
    },
  );
});
