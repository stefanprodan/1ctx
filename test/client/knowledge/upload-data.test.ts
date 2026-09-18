// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyKnowledge,
  fileTexts,
  fileVersions,
  lists,
  loadKnowledge,
  loadVersions,
  readFile,
  readVersion,
  uploadFile,
  versionTexts,
} from "../../../src/client/data/knowledge.ts";
import { me } from "../../../src/client/data/me.ts";
import type {
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeList,
  KnowledgeUploadResult,
  KnowledgeVersion,
} from "../../../src/shared/contracts/knowledge.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const user: Me = {
  id: "u1",
  username: "reader",
  fullName: "Reader",
  role: "member",
  mustChangePassword: false,
};
const base = "/api/projects/p1/knowledge";
const filePath = (id: string) => `${base}/files/${id}`;

function file(changes: Partial<KnowledgeFile> = {}): KnowledgeFile {
  return {
    id: "f1",
    projectId: "p1",
    name: "docs/runbook.md",
    kind: "md",
    bytes: 3,
    lines: 1,
    tokens: 1,
    revision: 1,
    author: {
      kind: "user",
      id: user.id,
      name: user.username,
      sessionId: null,
      origin: null,
    },
    createdAt: 1,
    updatedAt: 1,
    ...changes,
  };
}

function deleted(changes: Partial<KnowledgeFile> = {}): KnowledgeDeleted {
  const row = file({ id: "deleted", revision: 2, ...changes });
  return { ...row, deletedBy: row.author, deletedAt: 2 };
}

function version(row: KnowledgeFile): KnowledgeVersion {
  return {
    id: `v-${row.id}-${row.revision}`,
    fileId: row.id,
    name: row.name,
    revision: row.revision,
    bytes: row.bytes,
    lines: row.lines,
    author: row.author,
    writtenAt: row.updatedAt,
    deleted: false,
  };
}

function list(
  files: KnowledgeFile[] = [file()],
  removed: KnowledgeDeleted[] = [],
): KnowledgeList {
  return {
    files,
    deleted: removed,
    totals: {
      files: files.length,
      bytes: files.reduce((n, row) => n + row.bytes, 0),
      tokens: files.reduce((n, row) => n + row.tokens, 0),
    },
    limits: {
      fileBytes: 262_144,
      files: 500,
      projectBytes: 16_777_216,
      historyDays: 90,
    },
  };
}

const uploaded: KnowledgeUploadResult = {
  added: 0,
  replaced: 1,
  unchanged: 0,
  renamed: 1,
  saved: ["docs/runbook.md"],
  skipped: [],
  skippedTotal: 0,
};

class FakeXhr {
  method = "";
  path = "";
  async = false;
  headers = new Headers();
  body: Blob | null = null;
  aborted = false;
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  upload: {
    onprogress: ((event: { loaded: number; total: number }) => void) | null;
  } = { onprogress: null };

  constructor() {
    requests.push(this);
  }

  open(method: string, path: string, async: boolean): void {
    this.method = method;
    this.path = path;
    this.async = async;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(body: Blob): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  respond(body: unknown, status = 200): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const realFetch = globalThis.fetch;
const realXhr = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
const initialMe = me.value;
let requests: FakeXhr[] = [];
let fetched: string[] = [];
let routes = new Map<string, () => Response | Promise<Response>>();

beforeEach(() => {
  me.value = null;
  me.value = user;
  requests = [];
  fetched = [];
  routes = new Map();
  globalThis.fetch = (async (input) => {
    const path = String(input);
    fetched.push(path);
    const route = routes.get(path);
    if (!route) throw new Error(`Unexpected fetch: ${path}`);
    return route();
  }) as typeof fetch;
  Object.defineProperty(globalThis, "XMLHttpRequest", {
    configurable: true,
    value: FakeXhr,
  });
});

afterEach(() => {
  me.value = null;
  me.value = initialMe;
  globalThis.fetch = realFetch;
  if (realXhr) Object.defineProperty(globalThis, "XMLHttpRequest", realXhr);
  else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
});

function answer(path: string, body: unknown): void {
  routes.set(path, () => Response.json(body));
}

function pending(path: string): (body: unknown) => void {
  const { promise, resolve } = Promise.withResolvers<Response>();
  routes.set(path, () => promise);
  return (body) => resolve(Response.json(body));
}

async function hold(value = list()): Promise<void> {
  answer(base, value);
  await loadKnowledge("p1");
}

async function cache(row = file(), text = "old"): Promise<void> {
  answer(filePath(row.id), { file: { ...row, text } });
  answer(`${filePath(row.id)}/versions`, { versions: [version(row)] });
  await readFile("p1", row.id);
  await loadVersions("p1", row.id);
}

describe("knowledge upload transport", () => {
  test.serial(
    "sends the original File and raw query values with progress",
    async () => {
      const bytes = new Uint8Array([0x50, 0x4b, 0, 0x80, 0xff]);
      const picked = new File([bytes], "Q3 Plan & #?.zip");
      const folder = "My Docs\\Café & Q3/../";
      const progress: number[][] = [];
      const result = uploadFile("p /?", picked, folder, {
        onProgress: (sent, total) => progress.push([sent, total]),
      });
      const xhr = requests[0]!;
      const path = new URL(xhr.path, "http://local.test");
      expect(path.pathname).toBe("/api/projects/p%20%2F%3F/knowledge/upload");
      expect([...path.searchParams]).toEqual([
        ["folder", folder],
        ["name", picked.name],
      ]);
      expect(xhr.method).toBe("POST");
      expect(xhr.async).toBe(true);
      expect(xhr.headers.get("content-type")).toBe("application/octet-stream");
      expect(xhr.body).toBe(picked);
      expect(new Uint8Array(await xhr.body!.arrayBuffer())).toEqual(bytes);
      xhr.upload.onprogress?.({ loaded: 2, total: bytes.length });
      expect(progress).toEqual([[2, bytes.length]]);
      xhr.respond(uploaded);
      expect(await result).toEqual(uploaded);
      expect(fetched).toEqual([]);
    },
  );

  test.serial(
    "keeps the empty root and passes server failures through",
    async () => {
      const result = uploadFile("p1", new File(["text"], "Note.md"), "");
      const xhr = requests[0]!;
      expect(xhr.path).toBe(`${base}/upload?folder=&name=Note.md`);
      xhr.respond({ error: "folder must not contain .." }, 400);
      await expect(result).rejects.toMatchObject({
        status: 400,
        message: "folder must not contain ..",
      });
      expect(fetched).toEqual([]);
    },
  );

  test.serial(
    "forwards the signal without reloading after an abort",
    async () => {
      const stop = new AbortController();
      const result = uploadFile("p1", new File(["text"], "Note.md"), "", {
        signal: stop.signal,
      });
      stop.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(requests[0]?.aborted).toBe(true);
      expect(fetched).toEqual([]);
    },
  );

  test.serial("an already stopped request sends no File", async () => {
    await expect(
      uploadFile("p1", new File(["text"], "Note.md"), "", {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests[0]?.body).toBeNull();
    expect(fetched).toEqual([]);
  });

  for (const stop of [false, true]) {
    test.serial(
      `${stop ? "stopped" : "completed"} uploads leave one no-socket reload to the caller`,
      async () => {
        await hold();
        await cache();
        fetched = [];
        const changed = file({ revision: 2, updatedAt: 2 });
        const picked = new File(["new"], "Runbook.md");
        const first = uploadFile("p1", picked, "docs");
        requests[0]!.respond(uploaded);
        await first;
        const controller = new AbortController();
        const second = uploadFile("p1", picked, "docs", {
          signal: controller.signal,
        });
        if (stop) {
          requests[1]!.upload.onprogress?.({
            loaded: picked.size,
            total: picked.size,
          });
          controller.abort();
          await expect(second).rejects.toMatchObject({ name: "AbortError" });
        } else {
          requests[1]!.respond({ ...uploaded, replaced: 0, unchanged: 1 });
          await second;
        }
        expect(fetched).toEqual([]);
        expect(fileTexts.value.f1).toBe("old");
        answer(base, list([changed]));
        await loadKnowledge("p1");
        expect(fetched).toEqual([base]);
        expect(lists.value.get("p1")?.files[0]?.revision).toBe(2);
        expect(fileTexts.value.f1).toBeUndefined();
        expect(fileVersions.value.f1).toBeUndefined();
        await cache(changed, "new");
        expect(fileTexts.value.f1).toBe("new");
        expect(fileVersions.value.f1).toEqual([version(changed)]);
        expect(fetched.filter((path) => path === base)).toHaveLength(1);
      },
    );
  }
});

describe("knowledge list cache reconciliation", () => {
  test.serial(
    "drops removed live and deleted caches, keeping other projects",
    async () => {
      const gone = deleted({ name: "gone.md" });
      await hold(list([file()], [gone]));
      await cache();
      answer(`${filePath(gone.id)}/versions`, { versions: [version(gone)] });
      await loadVersions("p1", gone.id);
      const other = file({ id: "other", projectId: "p2" });
      const otherBase = "/api/projects/p2/knowledge";
      answer(otherBase, list([other]));
      await loadKnowledge("p2");
      answer(`${otherBase}/files/other`, { file: { ...other, text: "keep" } });
      answer(`${otherBase}/files/other/versions`, {
        versions: [version(other)],
      });
      await readFile("p2", "other");
      await loadVersions("p2", "other");
      await hold(list([]));
      expect(fileTexts.value).toEqual({ other: "keep" });
      expect(fileVersions.value).toEqual({ other: [version(other)] });
      expect(lists.value.get("p2")?.files).toEqual([other]);
    },
  );

  test.serial(
    "invalidates a changed deleted row's cached history",
    async () => {
      const row = deleted();
      await hold(list([], [row]));
      answer(`${filePath(row.id)}/versions`, { versions: [version(row)] });
      await loadVersions("p1", row.id);
      await hold(list([], [deleted({ revision: 3 })]));
      expect(fileVersions.value[row.id]).toBeUndefined();
      const latest = version(file({ id: row.id, revision: 3 }));
      answer(`${filePath(row.id)}/versions`, { versions: [latest] });
      expect(await loadVersions("p1", row.id)).toEqual([latest]);
    },
  );

  test.serial("drops a deleted id hidden by a newly live name", async () => {
    const gone = deleted();
    await hold(list([], [gone]));
    answer(`${filePath(gone.id)}/versions`, { versions: [version(gone)] });
    await loadVersions("p1", gone.id);
    await hold(list([file()], [gone]));
    expect(lists.value.get("p1")?.deleted).toEqual([]);
    expect(fileVersions.value[gone.id]).toBeUndefined();
  });

  test.serial(
    "retains unchanged live and deleted caches and immutable version text",
    async () => {
      const gone = deleted({ name: "gone.md" });
      await hold(list([file()], [gone]));
      await cache();
      answer(`${filePath(gone.id)}/versions`, { versions: [version(gone)] });
      await loadVersions("p1", gone.id);
      const v = version(file());
      answer(`${base}/versions/${v.id}`, { version: { ...v, text: "old" } });
      await readVersion("p1", v.id);
      const texts = fileTexts.value;
      const versions = fileVersions.value;
      const immutable = versionTexts.value;
      await hold(list([file()], [gone]));
      expect(fileTexts.value).toBe(texts);
      expect(fileVersions.value).toBe(versions);
      fetched = [];
      expect(await readFile("p1", "f1")).toBe("old");
      expect(await loadVersions("p1", "f1")).toEqual([v]);
      await loadVersions("p1", gone.id);
      expect(fetched).toEqual([]);
      await hold(list([file({ revision: 2 })]));
      expect(versionTexts.value).toBe(immutable);
    },
  );

  test.serial(
    "an overtaken list cannot clear a newer list's fresh caches",
    async () => {
      await hold();
      await cache();
      const settle = pending(base);
      const earlier = loadKnowledge("p1");
      const fresh = file({ revision: 3 });
      await hold(list([fresh]));
      await cache(fresh, "fresh");
      const texts = fileTexts.value;
      const versions = fileVersions.value;
      settle(list([]));
      await earlier;
      expect(lists.value.get("p1")?.files).toEqual([fresh]);
      expect(fileTexts.value).toBe(texts);
      expect(fileVersions.value).toBe(versions);
    },
  );

  test.serial(
    "a frame overtakes a list before fresh caches are read",
    async () => {
      await hold();
      await cache();
      const settle = pending(base);
      const earlier = loadKnowledge("p1");
      const fresh = file({ revision: 3 });
      applyKnowledge("p1", fresh, false);
      await cache(fresh, "fresh");
      const texts = fileTexts.value;
      const versions = fileVersions.value;
      settle(list([]));
      await earlier;
      expect(lists.value.get("p1")?.files).toEqual([fresh]);
      expect(fileTexts.value).toBe(texts);
      expect(fileVersions.value).toBe(versions);
    },
  );

  test.serial(
    "reads begun before a reload cannot refill invalidated caches",
    async () => {
      await hold();
      const text = pending(filePath("f1"));
      const history = pending(`${filePath("f1")}/versions`);
      const reading = readFile("p1", "f1");
      const loading = loadVersions("p1", "f1");
      await hold(list([file({ revision: 2 })]));
      text({ file: { ...file(), text: "old" } });
      history({ versions: [version(file())] });
      await Promise.all([reading, loading]);
      expect(fileTexts.value.f1).toBeUndefined();
      expect(fileVersions.value.f1).toBeUndefined();
      await cache(file({ revision: 2 }), "fresh");
      expect(fileTexts.value.f1).toBe("fresh");
    },
  );

  test.serial(
    "accepting a list also overtakes reads begun while it loaded",
    async () => {
      await hold();
      const settle = pending(base);
      const reload = loadKnowledge("p1");
      const text = pending(filePath("f1"));
      const history = pending(`${filePath("f1")}/versions`);
      const reading = readFile("p1", "f1");
      const loading = loadVersions("p1", "f1");
      const fresh = file({ revision: 2 });
      settle(list([fresh]));
      await reload;
      await cache(fresh, "fresh");
      const texts = fileTexts.value;
      const versions = fileVersions.value;
      text({ file: { ...file(), text: "old" } });
      history({ versions: [version(file())] });
      await Promise.all([reading, loading]);
      expect(fileTexts.value).toBe(texts);
      expect(fileVersions.value).toBe(versions);
      expect(fileTexts.value.f1).toBe("fresh");
      expect(fileVersions.value.f1).toEqual([version(fresh)]);
    },
  );

  test.serial(
    "reads of unchanged files can finish during a list reload",
    async () => {
      await hold();
      const settle = pending(base);
      const reload = loadKnowledge("p1");
      const text = pending(filePath("f1"));
      const history = pending(`${filePath("f1")}/versions`);
      const reading = readFile("p1", "f1");
      const loading = loadVersions("p1", "f1");
      settle(list([file(), file({ id: "f2", name: "new.md" })]));
      await reload;
      text({ file: { ...file(), text: "still current" } });
      history({ versions: [version(file())] });
      await Promise.all([reading, loading]);
      expect(fileTexts.value.f1).toBe("still current");
      expect(fileVersions.value.f1).toEqual([version(file())]);
    },
  );

  test.serial(
    "an old owner's list cannot clear the new owner's caches",
    async () => {
      await hold();
      await cache();
      const settle = pending(base);
      const earlier = loadKnowledge("p1");
      me.value = { ...user, id: "u2" };
      expect(fileTexts.value).toEqual({});
      expect(fileVersions.value).toEqual({});
      expect(lists.value.size).toBe(0);
      const fresh = file({ revision: 3 });
      await hold(list([fresh]));
      await cache(fresh, "fresh");
      const texts = fileTexts.value;
      const versions = fileVersions.value;
      settle(list([]));
      await earlier;
      expect(lists.value.get("p1")?.files).toEqual([fresh]);
      expect(fileTexts.value).toBe(texts);
      expect(fileVersions.value).toBe(versions);
    },
  );

  test.serial(
    "old-owner detail and history cannot refill the new owner's cache",
    async () => {
      await hold();
      const text = pending(filePath("f1"));
      const history = pending(`${filePath("f1")}/versions`);
      const reading = readFile("p1", "f1");
      const loading = loadVersions("p1", "f1");
      me.value = { ...user, id: "u2" };
      const fresh = file({ revision: 2 });
      await hold(list([fresh]));
      await cache(fresh, "fresh");
      const texts = fileTexts.value;
      const versions = fileVersions.value;
      text({ file: { ...file(), text: "old" } });
      history({ versions: [version(file())] });
      await Promise.all([reading, loading]);
      expect(fileTexts.value).toBe(texts);
      expect(fileVersions.value).toBe(versions);
    },
  );
});
