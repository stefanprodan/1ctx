// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A knowledge file's page as an entity: its states, another writer's
// revision kept as a notice while the reader reads, a delete keeping
// the text, and the page's own writes settling without a notice.

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { path } from "../../../src/client/app/router.ts";
import { ApiError } from "../../../src/client/data/api.ts";
import {
  knowledgeOf,
  lists,
  onKnowledgeSocket,
} from "../../../src/client/data/knowledge.ts";
import {
  deleteFile,
  docFileOf,
  heldSizes,
  loadDocFile,
  loadDocPage,
  onDocSocket,
  onlyLineMoved,
  renameFile,
  restoreFile,
  saveFile,
  showLatest,
} from "../../../src/client/data/knowledge-file.ts";
import {
  docHistories,
  historyOf,
  lastTextOf,
  loadHistory,
  onHistorySocket,
  versionOf,
} from "../../../src/client/data/knowledge-history.ts";
import {
  onSearchSocket,
  SEARCH_PAUSE_MS,
  searchKnowledge,
  searchOf,
} from "../../../src/client/data/knowledge-search.ts";
import { me } from "../../../src/client/data/me.ts";
import type {
  KnowledgeAuthor,
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeFileView,
  KnowledgeList,
  KnowledgeVersion,
  KnowledgeVersionView,
} from "../../../src/shared/contracts/knowledge.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const base = "/api/projects/p1/knowledge";
const page = "/projects/p1/knowledge/files/f1";

const reader: Me = {
  id: "u1",
  username: "reader",
  fullName: "Reader",
  role: "member",
  mustChangePassword: false,
};

const agent: KnowledgeAuthor = {
  kind: "agent",
  id: "a1",
  name: "sre",
  sessionId: "s1",
  origin: "chat",
};

function file(changes: Partial<KnowledgeFile> = {}): KnowledgeFile {
  return {
    id: "f1",
    projectId: "p1",
    name: "plans/a.md",
    kind: "md",
    bytes: 4,
    lines: 1,
    tokens: 1,
    revision: 3,
    author: agent,
    createdAt: 1,
    updatedAt: 10,
    ...changes,
  };
}

function view(changes: Partial<KnowledgeFileView> = {}): KnowledgeFileView {
  const row = file(changes);
  return {
    ...row,
    text: `text ${row.revision}\n`,
    language: null,
    html: `<p class="md-p">text ${row.revision}</p>`,
    code: null,
    ...changes,
  };
}

function version(changes: Partial<KnowledgeVersion> = {}): KnowledgeVersion {
  return {
    id: "v3",
    fileId: "f1",
    name: "plans/a.md",
    revision: 3,
    bytes: 4,
    lines: 1,
    author: agent,
    writtenAt: 10,
    deleted: false,
    ...changes,
  };
}

const versionView = (row: KnowledgeVersion): KnowledgeVersionView => ({
  ...row,
  text: `text ${row.revision}\n`,
  language: null,
  html: null,
  code: null,
});

function list(
  files: KnowledgeFile[] = [file()],
  deleted: KnowledgeDeleted[] = [],
): KnowledgeList {
  return {
    files,
    deleted,
    totals: { files: files.length, bytes: 0, tokens: 0 },
    limits: {
      fileBytes: 262_144,
      files: 500,
      projectBytes: 16_777_216,
      historyDays: 90,
    },
  };
}

type Answer = { status: number; body: unknown };
const realFetch = globalThis.fetch;
let routes: Map<string, () => Answer | Promise<Answer>>;
let asked: { key: string; body: unknown }[];

function answer(key: string, body: unknown, status = 200): void {
  routes.set(key, () => ({ status, body }));
}

// an answer the test gives when it chooses
function hold(key: string): (body: unknown, status?: number) => void {
  let give: (a: Answer) => void = () => {};
  const promise = new Promise<Answer>((resolve) => {
    give = resolve;
  });
  routes.set(key, () => promise);
  return (body, status = 200) => give({ status, body });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  me.value = null;
  me.value = reader;
  lists.value = new Map();
  path.value = page;
  routes = new Map();
  asked = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${input}`;
    asked.push({
      key,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const route = routes.get(key);
    const got = route === undefined ? { status: 404, body: {} } : await route();
    return new Response(JSON.stringify(got.body), { status: got.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  path.value = "/";
});

const open = async (row = view()) => {
  answer(`GET ${base}`, list([row]));
  answer(`GET ${base}/files/f1`, { file: row });
  await loadDocPage("p1", "f1", new URLSearchParams());
};

const shown = () => {
  const doc = docFileOf("f1");
  if (doc.state !== "done") throw new Error(`the page is ${doc.state}`);
  return doc;
};

describe("the file page", () => {
  test.serial("loads the file and the list side by side", async () => {
    expect(docFileOf("f1")).toEqual({ state: "loading" });
    await open();
    expect(shown().file.text).toBe("text 3\n");
    expect(knowledgeOf("p1")?.files).toHaveLength(1);
  });

  test.serial("a file not found is missing", async () => {
    answer(`GET ${base}`, list([]));
    await loadDocPage("p1", "f1", new URLSearchParams());
    expect(docFileOf("f1")).toEqual({ state: "missing" });
    expect(asked.some((a) => a.key.endsWith("/versions"))).toBe(false);
  });

  test.serial("a failed load keeps the words and the status", async () => {
    answer(`GET ${base}/files/f1`, { error: "the disk is full" }, 500);
    await loadDocFile("p1", "f1");
    expect(docFileOf("f1")).toEqual({
      state: "failed",
      failure: { words: "the disk is full", status: 500 },
    });
  });

  test.serial(
    "a deleted file reads its last text from its history",
    async () => {
      const live = version({ id: "v3", revision: 3 });
      const removed = version({ id: "v4", revision: 4, deleted: true });
      answer(
        `GET ${base}`,
        list([], [{ ...file(), deletedBy: agent, deletedAt: 20 }]),
      );
      answer(`GET ${base}/files/f1/versions`, { versions: [removed, live] });
      answer(`GET ${base}/versions/v3`, { version: versionView(live) });
      await loadDocPage("p1", "f1", new URLSearchParams());
      expect(docFileOf("f1").state).toBe("missing");
      const last = lastTextOf("f1");
      expect(last.state === "done" && last.version.text).toBe("text 3\n");
    },
  );

  test.serial("?revision= reads that revision and the one before", async () => {
    const versions = [
      version({ id: "v3", revision: 3 }),
      version({ id: "v2", revision: 2 }),
    ];
    answer(`GET ${base}/files/f1/versions`, { versions });
    for (const v of versions) {
      answer(`GET ${base}/versions/${v.id}`, { version: versionView(v) });
    }
    answer(`GET ${base}`, list());
    answer(`GET ${base}/files/f1`, { file: view() });
    await loadDocPage("p1", "f1", new URLSearchParams("revision=3"));
    expect(versionOf("v3").state).toBe("done");
    expect(versionOf("v2").state).toBe("done");
    expect(docHistories.value.get("f1")?.state).toBe("done");
  });
});

describe("another writer while the page is open", () => {
  test.serial(
    "a frame's newer revision is a notice, not a new text",
    async () => {
      await open();
      const theirs = file({ revision: 4, updatedAt: 40 });
      onDocSocket({
        type: "knowledge",
        projectId: "p1",
        file: theirs,
        deleted: false,
      });
      expect(shown().file.text).toBe("text 3\n");
      expect(shown().newer).toEqual(theirs);
      answer(`GET ${base}/files/f1`, { file: view({ revision: 4 }) });
      await showLatest("f1");
      expect(shown().file.text).toBe("text 4\n");
      expect(shown().newer).toBeNull();
    },
  );

  test.serial("the list's newer row is the same notice", async () => {
    await open();
    answer(`GET ${base}`, list([file({ revision: 5 })]));
    await loadDocPage("p1", "f1", new URLSearchParams("history"));
    expect(shown().file.revision).toBe(3);
    expect(shown().newer?.revision).toBe(5);
  });

  test.serial("a load again on the page keeps the reader's text", async () => {
    await open();
    answer(`GET ${base}/files/f1`, { file: view({ revision: 4 }) });
    await loadDocFile("p1", "f1");
    expect(shown().file.revision).toBe(3);
    expect(shown().newer?.revision).toBe(4);
    // the read is kept, so Show the latest asks nothing
    asked = [];
    await showLatest("f1");
    expect(asked).toEqual([]);
    expect(shown().file.revision).toBe(4);
  });

  test.serial("coming back to the page shows the latest", async () => {
    await open();
    path.value = "/projects/p1/knowledge";
    path.value = page;
    answer(`GET ${base}/files/f1`, { file: view({ revision: 4 }) });
    await loadDocFile("p1", "f1");
    expect(shown().file.revision).toBe(4);
    expect(shown().newer).toBeNull();
  });

  test.serial("a delete marks the page and keeps its text", async () => {
    await open();
    const deleter = { ...agent, name: "ops" };
    onDocSocket({
      type: "knowledge",
      projectId: "p1",
      file: file({ revision: 4, author: deleter, updatedAt: 50 }),
      deleted: true,
    });
    expect(shown().deleted).toEqual({ by: deleter, at: 50, revision: 4 });
    expect(shown().file.text).toBe("text 3\n");
  });
});

describe("the page's own writes", () => {
  test.serial(
    "a save's own frame, even ahead of its answer, is no notice",
    async () => {
      await open();
      const give = hold(`PUT ${base}/files/f1`);
      const saved = file({ revision: 4, bytes: 9 });
      answer(`GET ${base}/files/f1`, {
        file: view({ revision: 4, text: "mine\n" }),
      });
      const saving = saveFile("p1", "f1", "mine\n", 3);
      await settle();
      onDocSocket({
        type: "knowledge",
        projectId: "p1",
        file: saved,
        deleted: false,
      });
      give({ file: saved });
      expect(await saving).toEqual(saved);
      expect(asked.find((a) => a.key.startsWith("PUT"))?.body).toEqual({
        text: "mine\n",
        revision: 3,
      });
      expect(shown().file.text).toBe("mine\n");
      expect(shown().file.revision).toBe(4);
      expect(shown().newer).toBeNull();
      expect(knowledgeOf("p1")?.files[0]?.revision).toBe(4);
    },
  );

  test.serial(
    "a stale save is a 409 and the other write's notice stays",
    async () => {
      await open();
      const give = hold(`PUT ${base}/files/f1`);
      const saving = saveFile("p1", "f1", "mine\n", 3);
      await settle();
      const theirs = file({ revision: 4 });
      onDocSocket({
        type: "knowledge",
        projectId: "p1",
        file: theirs,
        deleted: false,
      });
      // held back while the write is out
      expect(shown().newer).toBeNull();
      give({ error: "The file changed since you opened it." }, 409);
      const refused = await saving.catch((err: unknown) => err);
      expect(refused instanceof ApiError && refused.status).toBe(409);
      expect(shown().newer).toEqual(theirs);
      expect(shown().file.text).toBe("text 3\n");
    },
  );

  test.serial("a write landing right after the save is a notice", async () => {
    await open();
    answer(`PUT ${base}/files/f1`, { file: file({ revision: 4 }) });
    answer(`GET ${base}/files/f1`, { file: view({ revision: 5 }) });
    await saveFile("p1", "f1", "mine\n", 3);
    expect(shown().file.revision).toBe(4);
    expect(shown().file.text).toBe("mine\n");
    expect(shown().newer?.revision).toBe(5);
    asked = [];
    await showLatest("f1");
    expect(asked).toEqual([]);
    expect(shown().file.text).toBe("text 5\n");
  });

  test.serial(
    "a delete from the page leaves it missing, and a visit loads",
    async () => {
      await open();
      answer(`DELETE ${base}/files/f1`, {});
      await deleteFile("p1", "f1");
      expect(docFileOf("f1")).toEqual({ state: "missing" });
      expect(knowledgeOf("p1")?.files).toEqual([]);
      onDocSocket({
        type: "knowledge",
        projectId: "p1",
        file: file({ revision: 4 }),
        deleted: true,
      });
      path.value = "/projects/p1/knowledge";
      path.value = page;
      const live = version({ id: "v3", revision: 3 });
      answer(
        `GET ${base}`,
        list(
          [],
          [{ ...file({ revision: 4 }), deletedBy: agent, deletedAt: 20 }],
        ),
      );
      answer(`GET ${base}/files/f1/versions`, {
        versions: [version({ id: "v4", revision: 4, deleted: true }), live],
      });
      answer(`GET ${base}/versions/v3`, { version: versionView(live) });
      routes.delete(`GET ${base}/files/f1`);
      await loadDocPage("p1", "f1", new URLSearchParams());
      expect(docFileOf("f1")).toEqual({ state: "missing" });
      const last = lastTextOf("f1");
      expect(last.state === "done" && last.version.text).toBe("text 3\n");
    },
  );

  test.serial("a rename moves the list's row and the page's name", async () => {
    await open();
    const moved = file({ name: "done/a.md", revision: 4 });
    answer(`PATCH ${base}/files/f1`, { file: moved });
    answer(`GET ${base}/files/f1`, {
      file: view({ name: "done/a.md", revision: 4 }),
    });
    expect(await renameFile("p1", "f1", "done/a.md", 3)).toEqual(moved);
    expect(asked.find((a) => a.key.startsWith("PATCH"))?.body).toEqual({
      name: "done/a.md",
      revision: 3,
    });
    expect(knowledgeOf("p1")?.files.map((row) => row.name)).toEqual([
      "done/a.md",
    ]);
    expect(shown().file.name).toBe("done/a.md");
    expect(shown().newer).toBeNull();
  });

  test.serial("a restore makes the name again from the kept text", async () => {
    await open();
    onDocSocket({
      type: "knowledge",
      projectId: "p1",
      file: file({ revision: 4 }),
      deleted: true,
    });
    const made = file({ id: "f2", revision: 1 });
    answer(`POST ${base}`, { file: made });
    expect(await restoreFile("p1", "f1", "plans/a.md")).toEqual(made);
    expect(asked.find((a) => a.key.startsWith("POST"))?.body).toEqual({
      name: "plans/a.md",
      text: "text 3\n",
    });
    answer(`POST ${base}`, { error: "A file named plans/a.md exists." }, 409);
    const refused = await restoreFile("p1", "f1", "plans/a.md").catch(
      (err: unknown) => err,
    );
    expect(refused instanceof ApiError && refused.status).toBe(409);
  });
});

const frame = (row: KnowledgeFile, deleted = false) =>
  onDocSocketBoth({ type: "knowledge", projectId: "p1", file: row, deleted });

// a frame as the socket hands it to each knowledge entity
function onDocSocketBoth(ev: Parameters<typeof onDocSocket>[0]): void {
  onKnowledgeSocket(ev);
  onDocSocket(ev);
  onHistorySocket(ev);
  onSearchSocket(ev);
}

describe("a later word than the write's answer", () => {
  test.serial(
    "a live revision 5 before a revision 4 save's answer stays",
    async () => {
      await open();
      const give = hold(`PUT ${base}/files/f1`);
      answer(`GET ${base}/files/f1`, { file: view({ revision: 5 }) });
      const saving = saveFile("p1", "f1", "mine\n", 3);
      await settle();
      frame(file({ revision: 5 }));
      give({ file: file({ revision: 4 }) });
      await saving;
      expect(knowledgeOf("p1")?.files[0]?.revision).toBe(5);
      // the page shows what it saved and knows of 5
      expect(shown().file.text).toBe("mine\n");
      expect(shown().newer?.revision).toBe(5);
    },
  );

  test.serial(
    "a delete at revision 5 before a revision 4 rename's answer stays",
    async () => {
      await open();
      const give = hold(`PATCH ${base}/files/f1`);
      const renaming = renameFile("p1", "f1", "b.md", 3);
      await settle();
      frame(file({ revision: 5, updatedAt: 60 }), true);
      give({ file: file({ name: "b.md", revision: 4 }) });
      await renaming;
      expect(knowledgeOf("p1")?.files).toEqual([]);
      expect(knowledgeOf("p1")?.deleted.map((row) => row.revision)).toEqual([
        5,
      ]);
      expect(shown().deleted?.revision).toBe(5);
      expect(shown().file.text).toBe("text 3\n");
    },
  );

  test.serial(
    "a delete during the read after a save marks the page",
    async () => {
      await open();
      answer(`PUT ${base}/files/f1`, { file: file({ revision: 4 }) });
      const give = hold(`GET ${base}/files/f1`);
      const saving = saveFile("p1", "f1", "mine\n", 3);
      await settle();
      await settle();
      frame(file({ revision: 5, updatedAt: 70 }), true);
      give({}, 404);
      await saving;
      expect(shown().deleted?.revision).toBe(5);
      expect(shown().file.text).toBe("mine\n");
    },
  );

  test.serial(
    "a read after a save that finds no file, the frame missed",
    async () => {
      await open();
      answer(`PUT ${base}/files/f1`, { file: file({ revision: 4 }) });
      routes.delete(`GET ${base}/files/f1`);
      await saveFile("p1", "f1", "mine\n", 3);
      expect(docFileOf("f1")).toEqual({ state: "missing" });
    },
  );
});

describe("the page across users, projects and failures", () => {
  test.serial(
    "an old user's write answer leaves the new user's alone",
    async () => {
      await open();
      const give = hold(`PUT ${base}/files/f1`);
      const old = saveFile("p1", "f1", "old\n", 3);
      await settle();
      me.value = { ...reader, id: "u2" };
      await open();
      const next = hold(`PUT ${base}/files/f1`);
      const mine = saveFile("p1", "f1", "new\n", 3);
      await settle();
      const theirs = file({ revision: 9 });
      frame(theirs);
      give({ file: file({ revision: 4 }) });
      await old;
      // the old answer drained nothing and wrote nothing
      expect(knowledgeOf("p1")?.files[0]?.revision).toBe(9);
      expect(shown().newer).toBeNull();
      answer(`GET ${base}/files/f1`, {
        file: view({ revision: 5, text: "new\n" }),
      });
      next({ file: file({ revision: 5 }) });
      await mine;
      expect(shown().file.text).toBe("new\n");
      expect(shown().newer?.revision).toBe(9);
    },
  );

  test.serial("a failed load again keeps the text and says so", async () => {
    await open();
    answer(`GET ${base}/files/f1`, { error: "the disk is full" }, 500);
    await loadDocFile("p1", "f1");
    expect(shown().file.text).toBe("text 3\n");
    expect(shown().failure).toEqual({ words: "the disk is full", status: 500 });
    answer(`GET ${base}/files/f1`, { file: view() });
    await loadDocFile("p1", "f1");
    expect(shown().failure).toBeNull();
  });

  test.serial("a failed history load again drops the held one", async () => {
    answer(`GET ${base}/files/f1/versions`, { versions: [version()] });
    await loadHistory("p1", "f1");
    answer(`GET ${base}/files/f1/versions`, { error: "down" }, 503);
    await loadHistory("p1", "f1", true);
    expect(historyOf("f1")).toEqual({
      state: "failed",
      failure: { words: "down", status: 503 },
    });
  });

  test.serial("a revoked project leaves nothing of it held", async () => {
    await open();
    answer(`GET ${base}/files/f1/versions`, { versions: [version()] });
    await loadHistory("p1", "f1");
    // fake time for the search's pause alone, since the file's other
    // waits are real zero-delay turns
    jest.useFakeTimers();
    try {
      searchKnowledge("p1", "deploy");
      onDocSocketBoth({ type: "revoked", projectId: "p1" });
      expect(knowledgeOf("p1")).toBeNull();
      expect(docFileOf("f1")).toEqual({ state: "loading" });
      expect(docHistories.value.has("f1")).toBe(false);
      expect(searchOf("p1").state).toBe("idle");
      asked = [];
      jest.advanceTimersByTime(SEARCH_PAUSE_MS + 30);
      await new Promise<void>((resolve) => setImmediate(resolve));
      // the search's timer went with it
      expect(asked).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test.serial(
    "an emptied bin leaves an open deleted page with no text",
    async () => {
      await open();
      answer(`GET ${base}/files/f1/versions`, {
        versions: [
          version({ id: "v4", revision: 4, deleted: true }),
          version(),
        ],
      });
      await loadHistory("p1", "f1");
      frame(file({ revision: 4 }), true);
      expect(shown().deleted?.revision).toBe(4);
      onDocSocketBoth({ type: "knowledgeEmptied", projectId: "p1" });
      expect(docFileOf("f1")).toEqual({ state: "missing" });
      expect(lastTextOf("f1")).toEqual({ state: "none" });
    },
  );

  test.serial(
    "the maps beside the pages go with them past the cap",
    async () => {
      for (let i = 0; i < 20; i++) {
        const row = view({ id: `g${i}` });
        answer(`GET ${base}/files/g${i}`, { file: row });
        await loadDocFile("p1", `g${i}`);
      }
      const sizes = heldSizes();
      expect(sizes.docs).toBe(16);
      expect(sizes.turns).toBeLessThanOrEqual(16);
      expect(sizes.projects).toBeLessThanOrEqual(16);
      expect(sizes.latest).toBeLessThanOrEqual(16);
    },
  );
});

describe("a line number clicked", () => {
  test.serial("moves ?line= alone and reads nothing again", async () => {
    await open();
    expect(onlyLineMoved("p1", "f1", new URLSearchParams("line=30"))).toBe(
      false,
    );
    expect(onlyLineMoved("p1", "f1", new URLSearchParams("line=12"))).toBe(
      true,
    );
    // the same query again is a load again, a reconnect's
    expect(onlyLineMoved("p1", "f1", new URLSearchParams("line=12"))).toBe(
      false,
    );
    // a revision or the history reads what it needs
    expect(
      onlyLineMoved("p1", "f1", new URLSearchParams("history=&line=12")),
    ).toBe(false);
    expect(
      onlyLineMoved("p1", "f2", new URLSearchParams("history=&line=2")),
    ).toBe(false);
  });

  test.serial("reads again when the page is not current", async () => {
    await open();
    answer(`GET ${base}/files/f1`, { error: "down" }, 503);
    await loadDocFile("p1", "f1");
    onlyLineMoved("p1", "f1", new URLSearchParams("line=1"));
    expect(onlyLineMoved("p1", "f1", new URLSearchParams("line=2"))).toBe(
      false,
    );
  });
});
