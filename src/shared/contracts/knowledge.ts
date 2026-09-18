// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's knowledge base as the wire exposes it: text files its
// members seed and its agents keep with the bash tool. A file row
// travels without its text; the detail carries it. Every write is a
// version, the delete included, so the history outlives the file.

export type KnowledgeAuthor = {
  kind: "user" | "agent";
  id: string;
  // the username or the agent's name as it was at the write
  name: string;
  // the chat or run a command wrote from; null for the page
  sessionId: string | null;
  origin: "chat" | "automation" | null;
};

export type KnowledgeFile = {
  id: string;
  projectId: string;
  // a path of one to eight segments, isKnowledgeName
  name: string;
  // the extension as a word, empty when the name has none
  kind: string;
  bytes: number;
  lines: number;
  tokens: number;
  // 1 at creation, one more on every write
  revision: number;
  author: KnowledgeAuthor;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeFileDetail = KnowledgeFile & { text: string };

export type KnowledgeVersion = {
  id: string;
  fileId: string;
  name: string;
  revision: number;
  bytes: number;
  lines: number;
  author: KnowledgeAuthor;
  writtenAt: number;
  // the version a delete wrote: empty text, the deleter as its author
  deleted: boolean;
};

export type KnowledgeVersionDetail = KnowledgeVersion & { text: string };

export type KnowledgeTotals = { files: number; bytes: number; tokens: number };

export type KnowledgeLimits = {
  fileBytes: number;
  files: number;
  projectBytes: number;
  historyDays: number;
};

// a deleted file as the list shows it: its last live row, the delete
// version's author and time
export type KnowledgeDeleted = KnowledgeFile & {
  deletedBy: KnowledgeAuthor;
  deletedAt: number;
};

export type KnowledgeList = {
  files: KnowledgeFile[];
  deleted: KnowledgeDeleted[];
  totals: KnowledgeTotals;
  limits: KnowledgeLimits;
};

// the aside's and the tab's count
export type KnowledgeCounts = { files: number; tokens: number };

export type KnowledgeUploadReason =
  | "not-regular"
  | "outside"
  | "no-letters"
  | "too-long"
  | "bad-name"
  | "duplicate"
  | "too-big"
  | "not-text"
  | "clash"
  | "clash-live";

export type KnowledgeUploadResult = {
  added: number;
  replaced: number;
  unchanged: number;
  renamed: number;
  saved: string[];
  skipped: {
    index: number;
    // At most 200 characters and 300 JSON bytes, including escaped controls.
    name: string;
    reason: KnowledgeUploadReason;
    other?: number;
  }[];
  skippedTotal: number;
};
