// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  KnowledgeListResponse,
  KnowledgeSearchResponse,
  KnowledgeVersionsResponse,
} from "../../shared/api/knowledge.ts";
import type {
  ExternalTaskDetail,
  ExternalTaskEntry,
  ExternalTaskRow,
} from "../../shared/contracts/external-task.ts";
import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import type { AgentEntryKind, ExternalTaskState } from "../../shared/words.ts";
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
  oneAtATime<T>(userId: string, scan: () => T): T;
  list(projectId: string): KnowledgeListResponse;
  projectOf(kind: "file" | "version", id: string): string | null;
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
  byId(id: string): SessionRow | null;
  exportRows(sessionId: string): ExportRow[];
  // access is the caller's: the project is checked before either
  search(projectId: string, q: string, after: string | null): SessionSearchPage;
  list(
    projectId: string,
    since: number | null,
    after: string | null,
  ): SessionListPage;
};

// the key an agent calls through; claims and entries carry its id and
// name
export type TaskKey = { userId: string; keyId: string; keyName: string };

// a task as the agent reads it; answered marks a claim of the calling key
// whose task has an answer after the claim's last entry
export type TaskListRow = ExternalTaskRow & {
  answered: boolean;
  // resumes after this row when the tool cuts a page to its byte budget
  cursor: string;
};

export type TaskShow = {
  task: ExternalTaskDetail;
  entries: ExternalTaskEntry[];
  // the entry id to ask before, null at the first
  next: string | null;
  idleHours: number;
};

// access is the caller's: the tool checks the key reaches the task's
// project (projectOf) before show, claim or report, and passes only
// reachable projects to list. A refusal throws HttpError with the
// state's words; a stale or ended claim answers 409, a missing task 404
export type TasksPort = {
  projectOf(taskId: string): string | null;
  // projectIds already narrowed to the key's; held keeps only the
  // key's open claims and ignores states. Rows carry no brief text;
  // after is the cursor of the row before, latest move first
  list(input: {
    projectIds: string[];
    states: ExternalTaskState[];
    held: TaskKey | null;
    after: string | null;
    limit: number;
  }): { rows: TaskListRow[]; next: string | null };
  show(taskId: string, before: string | null): TaskShow | null;
  // open to claimed; the same key holding it answers that claim again
  claim(key: TaskKey, taskId: string): TaskShow & { claimId: string };
  // the claim must belong to taskId; a live retry must repeat both the
  // claim's and task's last entry. A result or release retry answers
  // the original end even after later task entries
  report(
    key: TaskKey,
    taskId: string,
    claimId: string,
    kind: AgentEntryKind,
    text: string,
    links: string[],
  ): { entry: ExternalTaskEntry; task: ExternalTaskRow };
};

export type McpServerDeps = {
  db: Db;
  access: AccessPort;
  knowledge: KnowledgePort;
  projects: ProjectsPort;
  sessions: SessionsPort;
  tasks: TasksPort;
  clock(): number;
  log: Log;
  version: string;
};
