// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The knowledge list held per project: bounded, dropped on a failed
// load and on a revocation, and never moved back by a write's answer
// older than what a frame brought, or by an answer for another user.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fileTexts,
  knowledgeOf,
  listErrors,
  lists,
  loadKnowledge,
  onKnowledgeSocket,
  readFile,
  replaceFile,
} from "../../../src/client/data/knowledge.ts";
import { me } from "../../../src/client/data/me.ts";
import type {
  KnowledgeFile,
  KnowledgeList,
} from "../../../src/shared/contracts/knowledge.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const reader: Me = {
  id: "u1",
  username: "reader",
  fullName: "Reader",
  role: "member",
  mustChangePassword: false,
};

function file(changes: Partial<KnowledgeFile> = {}): KnowledgeFile {
  return {
    id: "f1",
    projectId: "p1",
    name: "a.md",
    kind: "md",
    bytes: 1,
    lines: 1,
    tokens: 1,
    revision: 3,
    author: {
      kind: "user",
      id: "u1",
      name: "reader",
      sessionId: null,
      origin: null,
    },
    createdAt: 1,
    updatedAt: 1,
    ...changes,
  };
}

const list = (files: KnowledgeFile[] = [file()]): KnowledgeList => ({
  files,
  deleted: [],
  totals: { files: files.length, bytes: 0, tokens: 0 },
  limits: { fileBytes: 1, files: 1, projectBytes: 1, historyDays: 1 },
});

type Answer = { status: number; body: unknown };
const realFetch = globalThis.fetch;
let routes: Map<string, () => Answer | Promise<Answer>>;

function answer(key: string, body: unknown, status = 200): void {
  routes.set(key, () => ({ status, body }));
}

beforeEach(() => {
  me.value = null;
  me.value = reader;
  routes = new Map();
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const route = routes.get(`${init?.method ?? "GET"} ${input}`);
    const got = route === undefined ? { status: 404, body: {} } : await route();
    return new Response(JSON.stringify(got.body), { status: got.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const base = (id: string) => `/api/projects/${id}/knowledge`;

describe("the list held", () => {
  test.serial("a failed load again drops it and says why", async () => {
    answer(`GET ${base("p1")}`, list());
    await loadKnowledge("p1");
    answer(`GET ${base("p1")}/files/f1`, { file: { ...file(), text: "t" } });
    await readFile("p1", "f1");
    answer(`GET ${base("p1")}`, { error: "down" }, 503);
    await loadKnowledge("p1");
    expect(knowledgeOf("p1")).toBeNull();
    expect(listErrors.value.get("p1")).toEqual({ words: "down", status: 503 });
    expect(fileTexts.value).toEqual({});
  });

  test.serial("a revocation drops it and its error", async () => {
    answer(`GET ${base("p1")}`, list());
    await loadKnowledge("p1");
    onKnowledgeSocket({ type: "revoked", projectId: "p1" });
    expect(knowledgeOf("p1")).toBeNull();
    expect(listErrors.value.has("p1")).toBe(false);
  });

  test.serial("holds sixteen projects, the least recent dropped", async () => {
    for (let i = 0; i < 18; i++) {
      answer(`GET ${base(`p${i}`)}`, list([file({ projectId: `p${i}` })]));
      await loadKnowledge(`p${i}`);
    }
    expect(lists.value.size).toBe(16);
    expect(knowledgeOf("p0")).toBeNull();
    expect(knowledgeOf("p17")).not.toBeNull();
  });

  test.serial(
    "a write's answer older than a frame's revision changes nothing",
    async () => {
      answer(`GET ${base("p1")}`, list());
      await loadKnowledge("p1");
      onKnowledgeSocket({
        type: "knowledge",
        projectId: "p1",
        file: file({ revision: 5 }),
        deleted: false,
      });
      answer(`PUT ${base("p1")}/files/f1`, { file: file({ revision: 4 }) });
      await replaceFile("p1", "f1", { text: "x", revision: 3 });
      expect(knowledgeOf("p1")?.files[0]?.revision).toBe(5);
    },
  );

  test.serial(
    "an old user's write answer leaves the new user's list",
    async () => {
      let give: (a: Answer) => void = () => {};
      routes.set(
        `PUT ${base("p1")}/files/f1`,
        () =>
          new Promise((resolve) => {
            give = resolve;
          }),
      );
      const old = replaceFile("p1", "f1", { text: "x", revision: 3 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      me.value = { ...reader, id: "u2" };
      let listed: (a: Answer) => void = () => {};
      routes.set(
        `GET ${base("p1")}`,
        () =>
          new Promise((resolve) => {
            listed = resolve;
          }),
      );
      const loading = loadKnowledge("p1");
      give({ status: 200, body: { file: file({ revision: 4 }) } });
      await old;
      listed({ status: 200, body: list() });
      await loading;
      // the new user's load was not overtaken by the old user's answer
      expect(knowledgeOf("p1")?.files[0]?.revision).toBe(3);
    },
  );
});
