// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A live file's head: which notice wins and which buttons show, the
// revision Save anyway saves over, and the page as it first draws.

import { afterEach, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { query } from "../../../../../src/client/app/router.ts";
import { lists } from "../../../../../src/client/data/knowledge.ts";
import {
  actionsKind,
  type HeadFacts,
  noticeKind,
  saveRevision,
} from "../../../../../src/client/views/knowledge/file/FileView.model.ts";
import { FileView } from "../../../../../src/client/views/knowledge/file/FileView.tsx";
import {
  type HeadProps,
  headActions,
  headNotice,
} from "../../../../../src/client/views/knowledge/file/Head.tsx";
import { fileView, list, sre } from "./fixtures.ts";

const facts = (over: Partial<HeadFacts> = {}): HeadFacts => ({
  mode: "read",
  problem: false,
  deleted: false,
  stale: false,
  conflict: false,
  restored: false,
  unbinned: false,
  newer: false,
  draft: false,
  reading: true,
  revision: false,
  ...over,
});

test("a refusal first, then what asks, then what is news", () => {
  const all = facts({
    problem: true,
    mode: "delete",
    deleted: true,
    newer: true,
    draft: true,
  });
  expect(noticeKind(all)).toBe("problem");
  expect(noticeKind({ ...all, problem: false })).toBe("delete");
  expect(noticeKind({ ...all, problem: false, mode: "read" })).toBe("deleted");
  expect(noticeKind(facts({ stale: true, conflict: true, mode: "edit" }))).toBe(
    "stale",
  );
  expect(noticeKind(facts({ mode: "edit", conflict: true }))).toBe("conflict");
  expect(noticeKind(facts({ newer: true, draft: true }))).toBe("newer");
  expect(noticeKind(facts({ restored: true, newer: true }))).toBe("restored");
  expect(noticeKind(facts({ unbinned: true }))).toBe("unbinned");
  // a kept edit to take up again says so first
  expect(noticeKind(facts({ unbinned: true, draft: true }))).toBe("draft");
  expect(noticeKind(facts({ draft: true }))).toBe("draft");
  // the history and a past revision say nothing of news or a draft
  expect(noticeKind(facts({ draft: true, reading: false }))).toBeNull();
  expect(noticeKind(facts({ mode: "edit", newer: true }))).toBeNull();
  expect(noticeKind(facts())).toBeNull();
});

test("the head's buttons go while something asks or the file is gone", () => {
  expect(actionsKind(facts())).toBe("read");
  expect(actionsKind(facts({ mode: "delete" }))).toBe("none");
  expect(actionsKind(facts({ deleted: true, mode: "edit" }))).toBe("none");
  expect(actionsKind(facts({ mode: "edit" }))).toBe("edit");
  expect(actionsKind(facts({ mode: "rename" }))).toBe("rename");
  expect(actionsKind(facts({ revision: true, reading: false }))).toBe(
    "revision",
  );
});

test("Save saves over the revision the editor began on, Save anyway theirs", () => {
  expect(saveRevision(3, 5, false)).toBe(3);
  expect(saveRevision(3, 5, true)).toBe(5);
});

const noop = () => {};
const head = (over: Partial<HeadProps> = {}): HeadProps => ({
  projectId: "p1",
  file: fileView(),
  now: 60_000,
  busy: false,
  pending: null,
  problem: null,
  failure: null,
  openIt: null,
  days: 90,
  deleted: null,
  latest: { author: sre, updatedAt: 0, revision: 4 },
  offered: null,
  editKept: false,
  restored: null,
  saveable: true,
  renameReady: true,
  restorable: true,
  more: [],
  on: {
    keep: noop,
    remove: noop,
    restoreFile: noop,
    showLatest: noop,
    discard: noop,
    edit: noop,
    cancelEdit: noop,
    save: noop,
    cancelRename: noop,
    restoreRevision: noop,
  },
  ...over,
});

// the head's helpers answer null for nothing to draw
const html = (node: unknown) => render(node as never);
const words = (node: unknown) => html(node).replace(/<[^>]*>/g, "");

test("the editor's buttons: Save, and Save anyway once told", () => {
  expect(words(headActions("edit", false, head()))).toBe("CancelSave");
  expect(words(headActions("edit", true, head()))).toBe("CancelSave anyway");
  expect(html(headActions("edit", false, head({ saveable: false })))).toContain(
    "disabled",
  );
  expect(html(headActions("rename", false, head()))).toContain(
    'form="docpage-rename"',
  );
  expect(headActions("none", false, head())).toBeNull();
});

test("a past revision's head is Restore, in words", () => {
  expect(words(headActions("revision", false, head()))).toBe("Restore");
});

test("a file brought back from the bin says so", () => {
  expect(words(headNotice("unbinned", head()))).toBe("Restored from the bin.");
});

test("a Restore says what it brought back and where the rest went", () => {
  const restored = head({ restored: { from: 1, replaced: 2 } });
  expect(words(headNotice("restored", restored))).toBe(
    "Restored revision 1. Revision 2 is in History.Show revision 2",
  );
  expect(html(headNotice("restored", restored))).toContain(
    'href="/projects/p1/knowledge/files/f1?revision=2"',
  );
});

test("the notices: their change, a delete while open, a kept edit", () => {
  expect(words(headNotice("conflict", head()))).toBe(
    "@sre in a chat changed this file 1m ago. Saving replaces their change. History keeps it.Show their change",
  );
  expect(html(headNotice("conflict", head()))).toContain(
    'href="/projects/p1/knowledge/files/f1?revision=4"',
  );
  expect(
    words(
      headNotice(
        "deleted",
        head({ deleted: { by: sre, at: 0, revision: 3 }, editKept: true }),
      ),
    ),
  ).toBe(
    "@sre in a chat deleted this file 1m ago. This is its last text. Restore brings back your unsaved edit.RestoreBack to Knowledge",
  );
  expect(
    words(
      headNotice(
        "draft",
        head({ offered: { text: "x", revision: 2, savedAt: 0 } }),
      ),
    ),
  ).toBe(
    "You have an unsaved edit of this file from 1m ago. The file changed since.DiscardResume",
  );
  expect(
    words(
      headNotice(
        "stale",
        head({ failure: { words: "the server went away", status: 502 } }),
      ),
    ),
  ).toBe("Could not load the latest. The server went away. HTTP 502");
  expect(headNotice(null, head())).toBeNull();
});

afterEach(() => {
  lists.value = new Map();
  query.value = "";
});

test.serial("a file drawn for reading: its tools and its band", () => {
  lists.value = new Map([["p1", list()]]);
  query.value = "";
  const page = render(
    <FileView
      projectId="p1"
      projectName="personal"
      file={fileView()}
      newer={null}
      deleted={null}
      failure={null}
      now={60_000}
    />,
  );
  expect(page).toContain(
    '<a class="page-crumb-on page-crumb-link page-crumb-path" href="/projects/p1/knowledge/files/f1"',
  );
  expect(page).toContain('aria-label="Edit"');
  expect(page).toContain('aria-label="More"');
  expect(page).not.toContain("page-notice");
  expect(page).toContain("Revision 3");
  expect(page).toContain('href="/projects/p1/knowledge/files/f1?history"');
});

test.serial("someone else's revision and a delete while open", () => {
  lists.value = new Map([["p1", list()]]);
  const newer = render(
    <FileView
      projectId="p1"
      projectName="personal"
      file={fileView()}
      newer={{ author: sre, updatedAt: 0, revision: 4 }}
      deleted={null}
      failure={null}
      now={60_000}
    />,
  );
  expect(newer).toContain("changed this file 1m ago.");
  expect(newer).toContain("Show the latest");
  const gone = render(
    <FileView
      projectId="p1"
      projectName="personal"
      file={fileView()}
      newer={null}
      deleted={{ by: sre, at: 0, revision: 3 }}
      failure={null}
      now={60_000}
    />,
  );
  expect(gone).toContain("deleted this file 1m ago. This is its last text.");
  expect(gone).not.toContain("page-actions");
});
