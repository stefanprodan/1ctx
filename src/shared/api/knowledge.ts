// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The knowledge routes, all under /api/projects/:id/knowledge and open
// to anyone who sees the project:
//   GET    .                          the list
//   POST   .                          {name, text}: a create, 201
//   POST   ./upload?folder=&name=      one file or archive as bytes
//   GET    ./files/:fileId            the file with its text
//   PUT    ./files/:fileId            {text, revision}: a replace
//   DELETE ./files/:fileId            204
//   GET    ./files/:fileId/versions   the versions, newest first
//   GET    ./versions/:versionId      one version with its text
// A stale revision, a taken name and a name prefixing a live one are
// 409s with the words the page shows.

import type {
  KnowledgeFile,
  KnowledgeFileDetail,
  KnowledgeList,
  KnowledgeVersion,
  KnowledgeVersionDetail,
} from "../contracts/knowledge.ts";

export type KnowledgeListResponse = KnowledgeList;

export type { KnowledgeUploadResult } from "../contracts/knowledge.ts";

export type CreateKnowledgeFileRequest = { name: string; text: string };
export type KnowledgeFileResponse = { file: KnowledgeFile };

export type KnowledgeFileDetailResponse = { file: KnowledgeFileDetail };

export type ReplaceKnowledgeFileRequest = { text: string; revision: number };

export type KnowledgeVersionsResponse = { versions: KnowledgeVersion[] };

export type KnowledgeVersionDetailResponse = {
  version: KnowledgeVersionDetail;
};
