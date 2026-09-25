// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The knowledge routes, all under /api/projects/:id/knowledge and open
// to anyone who sees the project:
//   GET    .                          the list
//   POST   .                          {name, text}: a create, 201
//   POST   ./upload?folder=&name=      one file or archive as bytes
//   GET    ./search?q=&after=         names and lines holding q, a page
//   GET    ./files/:fileId            the file with its text, rendered
//   PUT    ./files/:fileId            {text, revision}: a replace
//   PATCH  ./files/:fileId            {name, revision}: a rename
//   DELETE ./files/:fileId            204
//   GET    ./files/:fileId/versions   the versions, newest first
//   GET    ./versions/:versionId      one version with its text
// A stale revision, a taken name and a name prefixing a live one are
// 409s with the words the page shows.
//
// The chat uploads, under /api/projects/:id/uploads, the caller's own:
//   GET    .                          the staged items and the limits
//   POST   .?name=&attempt=           one file or archive as bytes
//   DELETE ./:uploadId                204

import type {
  KnowledgeFile,
  KnowledgeFileView,
  KnowledgeList,
  KnowledgeSearchHit,
  KnowledgeVersion,
  KnowledgeVersionView,
  StagedUpload,
  StagedUploads,
} from "../contracts/knowledge.ts";

export type KnowledgeListResponse = KnowledgeList;

export type { KnowledgeUploadResult } from "../contracts/knowledge.ts";

export type StagedUploadsResponse = StagedUploads;
export type StagedUploadResponse = StagedUpload;

export type EmptyBinResponse = { files: number };

export type CreateKnowledgeFileRequest = { name: string; text: string };
export type KnowledgeFileResponse = { file: KnowledgeFile };

export type KnowledgeFileDetailResponse = { file: KnowledgeFileView };

export type ReplaceKnowledgeFileRequest = { text: string; revision: number };

export type RenameKnowledgeFileRequest = { name: string; revision: number };

// q is 2 to 100 characters, matched as plain text in any case. The
// files whose text holds it come in name order, SEARCH_PAGE a page,
// after the name given as after; names are the files whose name alone
// holds it, on the first page only (none with after), at most
// SEARCH_NAMES of namesTotal
export type KnowledgeSearchResponse = {
  names: KnowledgeFile[];
  namesTotal: number;
  files: KnowledgeSearchHit[];
  // the name to pass as after for the next page, null on the last
  next: string | null;
};

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;
export const SEARCH_PAGE = 10;
export const SEARCH_NAMES = 50;
export const SEARCH_LINES = 3;
export const SEARCH_LINE_CHARS = 160;

export type KnowledgeVersionsResponse = { versions: KnowledgeVersion[] };

export type KnowledgeVersionDetailResponse = {
  version: KnowledgeVersionView;
};
