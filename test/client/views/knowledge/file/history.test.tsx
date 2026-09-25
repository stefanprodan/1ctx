// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The history in the file's card: ten rows a page, the newest leading
// to the file itself, and a note once every kept revision is shown.

import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { History } from "../../../../../src/client/views/knowledge/file/History.tsx";
import type {
  KnowledgeFileView,
  KnowledgeVersion,
} from "../../../../../src/shared/contracts/knowledge.ts";

const author = {
  kind: "agent" as const,
  id: "a1",
  name: "sre",
  sessionId: null,
  origin: null,
};

const file = {
  id: "f1",
  projectId: "p1",
  name: "apps/x.yaml",
  kind: "yaml",
  bytes: 1,
  lines: 1,
  tokens: 1,
  revision: 24,
  author,
  createdAt: 0,
  updatedAt: 0,
  text: "",
  language: null,
  html: null,
  code: null,
} satisfies KnowledgeFileView;

const versions = (from: number, to: number): KnowledgeVersion[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    id: `v${to - i}`,
    fileId: "f1",
    name: "apps/x.yaml",
    revision: to - i,
    bytes: 1,
    lines: 3,
    author,
    writtenAt: 0,
    deleted: false,
  }));

test("ten rows, the newest the file itself, then Show more", () => {
  const html = render(
    <History
      file={file}
      history={{ state: "done", versions: versions(5, 24) }}
      now={0}
    />,
  );
  expect(html).toContain("History</span> · 20 revisions kept");
  expect(html.match(/class="rows-line rows-go"/g)?.length).toBe(10);
  expect(html).toContain('href="/projects/p1/knowledge/files/f1"');
  expect(html).toContain('href="/projects/p1/knowledge/files/f1?revision=23"');
  expect(html.replace(/<[^>]*>/g, "")).toContain("@sre · 3 lines · latest");
  expect(html).toContain("Show more");
  expect(html).not.toContain("were dropped");
});

test("all shown: the note says what the limits dropped", () => {
  const html = render(
    <History
      file={file}
      history={{ state: "done", versions: versions(20, 24) }}
      now={0}
    />,
  );
  expect(html).toContain(
    "Revisions 1 to 19 were dropped to keep the history under its limits.",
  );
  expect(html).not.toContain("Show more");
});

test("none kept says so", () => {
  const html = render(
    <History file={file} history={{ state: "done", versions: [] }} now={0} />,
  );
  expect(html).toContain("No revisions are kept.");
});
