// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file, its versions and its list as the file page's tests hold them.

import type {
  KnowledgeAuthor,
  KnowledgeFileView,
  KnowledgeList,
  KnowledgeVersionView,
} from "../../../../../src/shared/contracts/knowledge.ts";

export const sre: KnowledgeAuthor = {
  kind: "agent",
  id: "a1",
  name: "sre",
  sessionId: "s1",
  origin: "chat",
};

export function fileView(
  over: Partial<KnowledgeFileView> = {},
): KnowledgeFileView {
  return {
    id: "f1",
    projectId: "p1",
    name: "apps/x.yaml",
    kind: "yaml",
    bytes: 12,
    lines: 2,
    tokens: 5,
    revision: 3,
    author: sre,
    createdAt: 0,
    updatedAt: 0,
    text: "a: 1\nb: 2\n",
    language: "yaml",
    html: null,
    code: null,
    ...over,
  };
}

export function versionView(
  revision: number,
  text: string,
): KnowledgeVersionView {
  return {
    id: `v${revision}`,
    fileId: "f1",
    name: "apps/x.yaml",
    revision,
    bytes: text.length,
    lines: text.split("\n").length - 1,
    author: sre,
    writtenAt: 0,
    deleted: false,
    text,
    language: "yaml",
    html: null,
    code: null,
  };
}

export function list(over: Partial<KnowledgeList> = {}): KnowledgeList {
  return {
    files: [],
    deleted: [],
    totals: { files: 6, bytes: 100, tokens: 6600 },
    limits: {
      fileBytes: 262144,
      files: 500,
      projectBytes: 1 << 24,
      historyDays: 90,
    },
    ...over,
  };
}
