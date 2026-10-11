// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  KnowledgeListResponse,
  KnowledgeSearchResponse,
  KnowledgeVersionsResponse,
} from "../../shared/api/knowledge.ts";
import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import type { Db } from "../db/index.ts";
import type { KnowledgeEdit } from "../knowledge/index.ts";
import type { Principal, Via } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { ProjectRow } from "../projects/index.ts";
import type {
  ExportRow,
  SessionListPage,
  SessionRow,
  SessionSearchPage,
} from "../sessions/index.ts";

export type KeyPrincipal = Omit<Principal, "via"> & {
  via: Extract<Via, { kind: "key" }>;
};

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
  reachableProjectIds(principal: Principal): string[];
  checkKey(principal: Principal, projectId: string): void;
};

export type KnowledgePort = {
  list(projectId: string): KnowledgeListResponse;
  rawFile(
    projectId: string,
    fileId: string,
  ): { id: string; name: string; revision: number; text: string } | null;
  versions(
    projectId: string,
    fileId: string,
  ): KnowledgeVersionsResponse["versions"];
  rawVersion(
    projectId: string,
    versionId: string,
  ): {
    id: string;
    name: string;
    revision: number;
    text: string;
    deleted: boolean;
  } | null;
  create(
    projectId: string,
    author: KnowledgeAuthor,
    name: string,
    text: string,
  ): { id: string; name: string; revision: number };
  edit(
    projectId: string,
    author: KnowledgeAuthor,
    fileId: string,
    revision: number,
    edits: readonly KnowledgeEdit[],
  ): { id: string; name: string; revision: number };
  replace(
    projectId: string,
    author: KnowledgeAuthor,
    fileId: string,
    text: string,
    revision: number,
  ): { id: string; name: string; revision: number };
  rename(
    projectId: string,
    author: KnowledgeAuthor,
    fileId: string,
    name: string,
    revision: number,
  ): { id: string; name: string; revision: number };
  remove(
    projectId: string,
    author: KnowledgeAuthor,
    fileId: string,
    revision?: number,
  ): { id: string; name: string; revision: number };
  search(
    projectId: string,
    userId: string,
    q: string,
    after: string | null,
  ): KnowledgeSearchResponse;
};

export type ProjectsPort = { byId(id: string): ProjectRow | null };

export type SessionsPort = {
  visible(principal: Principal, id: string): SessionRow;
  exportRows(sessionId: string): ExportRow[];
  // access is the caller's: the project is checked before either
  search(projectId: string, q: string, after: string | null): SessionSearchPage;
  list(
    projectId: string,
    since: number | null,
    after: string | null,
  ): SessionListPage;
};

export type McpServerDeps = {
  db: Db;
  access: AccessPort;
  knowledge: KnowledgePort;
  projects: ProjectsPort;
  sessions: SessionsPort;
  clock(): number;
  log: Log;
  version: string;
};
