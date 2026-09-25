// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure half of the knowledge pages: Recent and Deleted from the
// list held, the folders a link opens, the revisions a page compares,
// and how a file page takes another writer's word.

import { describe, expect, test } from "bun:test";
import {
  type DocFile,
  deletedByName,
  folderOf,
  lastLiveVersion,
  noticeRow,
  RECENT_PAGE,
  recentFiles,
  revisionPair,
  revisionParam,
  sameBesidesLine,
  takeView,
  withParents,
} from "../../../src/client/data/knowledge-rows.ts";
import type {
  KnowledgeAuthor,
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeFileView,
  KnowledgeVersion,
} from "../../../src/shared/contracts/knowledge.ts";

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
  return {
    ...file(),
    text: "old\n",
    language: null,
    html: "<p class='md-p'>old</p>",
    code: null,
    ...changes,
  };
}

function gone(changes: Partial<KnowledgeDeleted> = {}): KnowledgeDeleted {
  return { ...file(), deletedBy: agent, deletedAt: 20, ...changes };
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

const done = (changes: Partial<Extract<DocFile, { state: "done" }>> = {}) =>
  ({
    state: "done",
    file: view(),
    newer: null,
    deleted: null,
    failure: null,
    ...changes,
  }) as DocFile;

describe("the lists from the list held", () => {
  test("a query moved at ?line= alone is the same page", () => {
    expect(sameBesidesLine("line=30", "line=12")).toBe(true);
    expect(sameBesidesLine("", "line=12")).toBe(true);
    expect(sameBesidesLine("revision=3&line=1", "line=2&revision=3")).toBe(
      true,
    );
    expect(sameBesidesLine("line=3", "history=&line=3")).toBe(false);
    expect(sameBesidesLine("revision=3", "revision=4")).toBe(false);
  });

  test("Recent is every file by its last change, a page of twelve", () => {
    const rows = Array.from({ length: 14 }, (_, i) =>
      file({ id: `f${i}`, name: `n${i}.md`, updatedAt: i }),
    );
    const first = recentFiles(rows, 1);
    expect(first.rows).toHaveLength(RECENT_PAGE);
    expect(first.rows[0]?.id).toBe("f13");
    expect(first.more).toBe(true);
    const both = recentFiles(rows, 2);
    expect(both.rows).toHaveLength(14);
    expect(both.more).toBe(false);
  });

  test("Deleted is one row per name, its newest delete", () => {
    const rows = deletedByName([
      gone({ id: "d1", name: "x.md", deletedAt: 5 }),
      gone({ id: "d2", name: "x.md", deletedAt: 9 }),
      gone({ id: "d3", name: "y.md", deletedAt: 7 }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["d2", "d3"]);
  });

  test("a folder link opens the folder and its parents", () => {
    expect(withParents("plans/x/y")).toEqual(["plans", "plans/x", "plans/x/y"]);
    expect(withParents("")).toEqual([]);
    expect(withParents("/plans/")).toEqual(["plans"]);
    expect(folderOf("plans/x/a.md")).toBe("plans/x");
    expect(folderOf("a.md")).toBe("");
  });
});

describe("revisions", () => {
  const versions = [
    version({ id: "v5", revision: 5, deleted: true }),
    version({ id: "v4", revision: 4 }),
    version({ id: "v3", revision: 3 }),
    version({ id: "v1", revision: 1 }),
  ];

  test("a deleted file's last text is its newest live version", () => {
    expect(lastLiveVersion(versions)?.id).toBe("v4");
    expect(lastLiveVersion([version({ deleted: true })])).toBeNull();
  });

  test("a past revision is compared with the live one before it", () => {
    expect(revisionPair(versions, 4)).toEqual({
      version: versions[1] ?? null,
      before: versions[2] ?? null,
    });
    // history's limits dropped revision 2: the one kept before is it
    expect(revisionPair(versions, 3).before?.id).toBe("v1");
    expect(revisionPair(versions, 1).before).toBeNull();
    expect(revisionPair(versions, 2).version).toBeNull();
    expect(revisionPair(versions, 5).version).toBeNull();
  });

  test("?revision= is a positive whole number", () => {
    expect(revisionParam("22")).toBe(22);
    expect(revisionParam(null)).toBeNull();
    expect(revisionParam("0")).toBeNull();
    expect(revisionParam("2.5")).toBeNull();
    expect(revisionParam("x")).toBeNull();
  });
});

describe("another writer's word on a file page", () => {
  test("a newer revision is a notice and the text stays", () => {
    const next = noticeRow(done(), file({ revision: 4 }), null, 0);
    expect(next.state === "done" && next.file.text).toBe("old\n");
    expect(next.state === "done" && next.newer?.revision).toBe(4);
  });

  test("a revision at or under the page's, or its own write's, is nothing", () => {
    const doc = done();
    expect(noticeRow(doc, file({ revision: 3 }), null, 0)).toBe(doc);
    expect(noticeRow(doc, file({ revision: 4 }), null, 4)).toBe(doc);
    expect(noticeRow(doc, file({ id: "f2", revision: 9 }), null, 0)).toBe(doc);
    const noticed = done({ newer: file({ revision: 5 }) });
    expect(noticeRow(noticed, file({ revision: 4 }), null, 0)).toBe(noticed);
  });

  test("a delete marks the page and keeps its text", () => {
    const next = noticeRow(
      done({ newer: file({ revision: 4 }) }),
      file({ revision: 5 }),
      { by: agent, at: 30, revision: 5 },
      0,
    );
    expect(next).toEqual(
      done({ newer: null, deleted: { by: agent, at: 30, revision: 5 } }),
    );
    // a deleted page learns nothing more
    expect(noticeRow(next, file({ revision: 9 }), null, 0)).toBe(next);
  });

  test("a read swaps in on arrival and waits once the reader is on it", () => {
    const fresh = view({ revision: 4, text: "new\n" });
    const arrived = takeView(done(), fresh, true, 0);
    expect(arrived).toEqual(done({ file: fresh }));
    const reading = takeView(done(), fresh, false, 0);
    expect(reading.state === "done" && reading.file.text).toBe("old\n");
    expect(reading.state === "done" && reading.newer?.revision).toBe(4);
    // the same revision read again takes its rendering
    const same = view({ html: "<p class='md-p'>again</p>" });
    expect(takeView(done(), same, false, 0)).toEqual(done({ file: same }));
    // an older read never goes back
    const doc = done();
    expect(takeView(doc, view({ revision: 2 }), false, 0)).toBe(doc);
    // a first read is the page whatever the swap
    expect(takeView({ state: "loading" }, fresh, false, 0)).toEqual(
      done({ file: fresh }),
    );
  });

  test("a read from before a delete never brings the file back", () => {
    const doc = done({ deleted: { by: agent, at: 30, revision: 5 } });
    expect(takeView(doc, view({ revision: 4 }), true, 0)).toBe(doc);
  });

  test("a swap keeps a notice of a revision past the one read", () => {
    const doc = done({ newer: file({ revision: 6 }) });
    const next = takeView(doc, view({ revision: 4 }), true, 0);
    expect(next.state === "done" && next.newer?.revision).toBe(6);
    const caught = takeView(doc, view({ revision: 6 }), true, 0);
    expect(caught.state === "done" && caught.newer).toBeNull();
  });
});
