// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The file page's pure half: the crumb, the words, the outline, what
// the history dropped, the ‹ › steps and the path field's refusals.

import { expect, test } from "bun:test";
import { foldersOf } from "../../../../../src/client/lib/tree.ts";
import {
  crumbSteps,
  droppedBefore,
  droppedWords,
  folderHref,
  isStale,
  liveFolders,
  newFileIn,
  numberParam,
  outlineOf,
  pathFieldOf,
  pathReady,
  revisionSteps,
  shapePath,
  utf8Bytes,
} from "../../../../../src/client/views/knowledge/file/DocPage.model.ts";
import type {
  KnowledgeAuthor,
  KnowledgeVersion,
} from "../../../../../src/shared/contracts/knowledge.ts";

const agent: KnowledgeAuthor = {
  kind: "agent",
  id: "a1",
  name: "sre",
  sessionId: "s1",
  origin: "chat",
};

const version = (revision: number, deleted = false): KnowledgeVersion => ({
  id: `v${revision}`,
  fileId: "f1",
  name: "apps/podinfo.yaml",
  revision,
  bytes: 10,
  lines: 1,
  author: agent,
  writtenAt: revision,
  deleted,
});

test("the crumb leads to the project, the base and each folder", () => {
  expect(crumbSteps("p1", "personal", foldersOf("plans/x y/z.md"))).toEqual([
    { label: "personal", href: "/projects/p1" },
    { label: "Knowledge", href: "/projects/p1/knowledge" },
    {
      label: "plans",
      href: "/projects/p1/knowledge?folder=plans",
      mono: true,
      title: "plans",
    },
    {
      label: "x y",
      href: "/projects/p1/knowledge?folder=plans%2Fx%20y",
      mono: true,
      title: "plans/x y",
    },
  ]);
  // past two folders the middle folds into …, the deepest it holds
  const deep = crumbSteps("p1", "personal", foldersOf("a/b/c/d/e.md"));
  expect(deep.map((step) => step.label)).toEqual([
    "personal",
    "Knowledge",
    "a",
    "…",
    "d",
  ]);
  expect(deep[3]).toMatchObject({
    href: "/projects/p1/knowledge?folder=a%2Fb%2Fc",
    title: "a/b/c",
  });
  // a deleted file's folders link only while a live file keeps them
  const live = liveFolders([{ name: "old/keep.md" }]);
  expect([...live]).toEqual(["old"]);
  const gone = crumbSteps("p1", "personal", foldersOf("old/x/a.md"), live);
  expect(gone.slice(2).map((step) => [step.label, step.href])).toEqual([
    ["old", "/projects/p1/knowledge?folder=old"],
    ["x", undefined],
  ]);
  expect(folderHref("p1", "a")).toBe("/projects/p1/knowledge?folder=a");
  expect(newFileIn("p1", "")).toBe("/projects/p1/knowledge/new");
  expect(newFileIn("p1", "a/b")).toBe(
    "/projects/p1/knowledge/new?folder=a%2Fb",
  );
  expect(utf8Bytes("é")).toBe(2);
});

test("the outline is the second and third level headings, as text", () => {
  const html =
    '<h1 class="md-h1">Title</h1><p class="md-p">x</p>' +
    '<h2 class="md-h2">Why &amp; <code class="md-code">how</code></h2>' +
    '<h3 class="md-h3">Detail</h3><h2 class="md-h2"> </h2><h4 class="md-h4">no</h4>';
  expect(outlineOf(html)).toEqual([
    { level: 2, text: "Why & how" },
    { level: 3, text: "Detail" },
  ]);
  expect(outlineOf(null)).toEqual([]);
});

test("the history says what its limits dropped", () => {
  expect(droppedBefore([version(24), version(23), version(5)])).toBe(4);
  expect(droppedBefore([version(2), version(1)])).toBe(0);
  expect(droppedBefore([])).toBe(0);
  expect(droppedWords(1)).toBe(
    "Revision 1 was dropped to keep the history under its limits.",
  );
  expect(droppedWords(4)).toBe(
    "Revisions 1 to 4 were dropped to keep the history under its limits.",
  );
});

test("the steps skip deletes, the newest leading to the file as it is", () => {
  const versions = [version(24), version(23), version(22), version(21)];
  expect(revisionSteps(versions, 22)).toEqual({ older: 21, newer: 23 });
  expect(revisionSteps(versions, 23)).toEqual({ older: 22, newer: 24 });
  expect(revisionSteps(versions, 21)).toEqual({ older: null, newer: 22 });
  expect(revisionSteps(versions, 9)).toEqual({ older: null, newer: null });
  expect(revisionSteps([version(3), version(2, true), version(1)], 3)).toEqual({
    older: 1,
    newer: null,
  });
});

test("the path field owns the name's refusals, the head the rest", () => {
  expect(pathFieldOf("a file named plans/x.md exists")).toBe("path");
  expect(pathFieldOf("plans/x.md conflicts with file plans")).toBe("path");
  expect(pathFieldOf("the file is named x.md already")).toBe("path");
  expect(pathFieldOf("name must be 1 to 8 path segments")).toBe("path");
  expect(pathFieldOf("x.md is 9 bytes, the limit is 4")).toBeUndefined();
  expect(pathFieldOf("apps/x.yaml is at revision 7")).toBeUndefined();
  expect(isStale(409, "apps/x.yaml is at revision 7")).toBe(true);
  expect(isStale(409, "a file named x exists")).toBe(false);
});

test("a typed path and the query's numbers", () => {
  expect(shapePath("my notes/a b.md")).toBe("my-notes/a-b.md");
  expect(pathReady("plans/")).toBe(false);
  expect(pathReady("  ")).toBe(false);
  expect(pathReady("plans/x.md")).toBe(true);
  expect(numberParam("42")).toBe(42);
  expect(numberParam("0")).toBeNull();
  expect(numberParam("4x")).toBeNull();
  expect(numberParam(null)).toBeNull();
});
