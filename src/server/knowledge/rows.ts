// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The database shapes and their wire summaries, kept separate from text.
// Author names are stored at the write rather than joined from live users
// or agents, so history remains attributable after its author is gone.

import type {
  KnowledgeAuthor,
  KnowledgeFile,
  KnowledgeFileDetail,
  KnowledgeVersion,
} from "../../shared/contracts/knowledge.ts";

export type AuthorRaw = {
  author_kind: KnowledgeAuthor["kind"];
  author_id: string;
  author_name: string;
  session_id: string | null;
  origin: KnowledgeAuthor["origin"];
};

export type FileRaw = AuthorRaw & {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  bytes: number;
  lines: number;
  tokens: number;
  revision: number;
  created_at: number;
  updated_at: number;
};

export type KnowledgeRow = KnowledgeFileDetail & { digest: string };
export type FullRaw = FileRaw & { text: string; digest: string };

export const FILE_COLUMNS = `id, project_id, name, kind, bytes, lines, tokens,
  revision, author_kind, author_id, author_name, session_id, origin,
  created_at, updated_at`;

export function authorOf(raw: AuthorRaw): KnowledgeAuthor {
  return {
    kind: raw.author_kind,
    id: raw.author_id,
    name: raw.author_name,
    sessionId: raw.session_id,
    origin: raw.origin,
  };
}

export function fileOf(raw: FileRaw): KnowledgeFile {
  return {
    id: raw.id,
    projectId: raw.project_id,
    name: raw.name,
    kind: raw.kind,
    bytes: raw.bytes,
    lines: raw.lines,
    tokens: raw.tokens,
    revision: raw.revision,
    author: authorOf(raw),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function summary({ text: _, digest: __, ...file }: KnowledgeRow) {
  return file;
}

export type VersionRaw = AuthorRaw & {
  id: string;
  file_id: string;
  name: string;
  revision: number;
  bytes: number;
  lines: number;
  written_at: number;
  deleted: number;
};

export const VERSION_COLUMNS = `id, file_id, name, revision, bytes, lines,
  author_kind, author_id, author_name, session_id, origin, written_at, deleted`;

export function versionOf(raw: VersionRaw): KnowledgeVersion {
  return {
    id: raw.id,
    fileId: raw.file_id,
    name: raw.name,
    revision: raw.revision,
    bytes: raw.bytes,
    lines: raw.lines,
    author: authorOf(raw),
    writtenAt: raw.written_at,
    deleted: raw.deleted === 1,
  };
}
