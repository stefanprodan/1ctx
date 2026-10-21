// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test";
import { NotFound } from "../../../src/server/lib/errors.ts";
import type {
  Principal,
  RouteDescriptor,
} from "../../../src/server/lib/http.ts";
import { type Log, silent } from "../../../src/server/lib/log.ts";
import { mcpServerArea } from "../../../src/server/mcp-server/index.ts";
import type {
  McpServerDeps,
  TaskKey,
  TaskListRow,
  TaskShow,
  TasksPort,
} from "../../../src/server/mcp-server/ports.ts";
import type {
  ExportRow,
  SessionListPage,
  SessionSearchPage,
} from "../../../src/server/sessions/index.ts";
import type {
  KnowledgeListResponse,
  KnowledgeSearchResponse,
} from "../../../src/shared/api/knowledge.ts";
import {
  type ExternalTaskDetail,
  type ExternalTaskEntry,
  type ExternalTaskRow,
  MAX_TASK_FILES,
  MAX_TASK_LABELS,
} from "../../../src/shared/contracts/external-task.ts";
import type {
  KnowledgeFileView,
  KnowledgeVersion,
} from "../../../src/shared/contracts/knowledge.ts";
import { MAX_LABEL_NAME } from "../../../src/shared/contracts/label.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";
import { MAX_KNOWLEDGE_NAME, MAX_TITLE } from "../../../src/shared/words.ts";
import { memoryDb } from "../../helpers/db.ts";

export const project = {
  id: "project00001",
  kind: "team" as const,
  name: "alpha",
  ownerId: "user00000001",
  createdAt: 1,
  description: "",
};

const key = (scope: "read" | "write" = "read"): Principal => ({
  userId: "user00000001",
  username: "casey",
  fullName: "Casey",
  role: "member",
  mustChangePassword: false,
  via: {
    kind: "key",
    id: "key000000001",
    name: "laptop",
    scope,
    projectIds: [project.id],
  },
});

export const file = (text = "hello"): KnowledgeFileView => ({
  id: "file00000001",
  projectId: project.id,
  name: "notes/readme.md",
  kind: "md",
  bytes: Buffer.byteLength(text),
  lines: 1,
  tokens: 1,
  revision: 7,
  author: {
    kind: "user",
    id: "user00000001",
    name: "casey",
    sessionId: null,
    origin: null,
    keyName: null,
  },
  createdAt: 1,
  updatedAt: 2,
  text,
  language: "markdown",
  html: null,
  code: null,
});

export const externalTaskRow = (
  overrides: Partial<ExternalTaskRow> = {},
): ExternalTaskRow => ({
  id: "task00000001",
  projectId: project.id,
  title: "Review the proposal",
  labels: ["build"],
  state: "todo",
  revision: 1,
  editRevision: 1,
  claim: null,
  last: null,
  entries: 0,
  claimLimit: false,
  createdBy: { id: "user00000001", username: "casey" },
  createdAt: 100,
  movedAt: 200,
  ...overrides,
});

export const externalTaskEntry = (
  overrides: Partial<ExternalTaskEntry> = {},
): ExternalTaskEntry => ({
  id: "entry0000001",
  kind: "progress",
  text: "Started the review.",
  links: [],
  by: { id: "user00000001", username: "casey" },
  keyName: "laptop",
  claimId: "claim0000001",
  claimEnd: null,
  chatId: null,
  chatTitle: null,
  at: 300,
  ...overrides,
});

export const externalTaskDetail = (
  row: ExternalTaskRow = externalTaskRow(),
): ExternalTaskDetail => ({
  task: row,
  files: [
    {
      fileId: "file00000001",
      name: "notes/readme.md",
      revision: 7,
      changedAt: 250,
      deleted: false,
    },
  ],
  briefAt: 100,
  chatId: null,
  chatTitle: null,
  createdKeyName: null,
});

// the largest detail a task can carry, so a page leaves its entries
// the least room
export const largestDetail = (): ExternalTaskDetail => ({
  ...externalTaskDetail(
    externalTaskRow({
      title: "\u{1F600}".repeat(MAX_TITLE),
      labels: Array.from({ length: MAX_TASK_LABELS }, (_, index) =>
        `${index}`.padEnd(MAX_LABEL_NAME, "x"),
      ),
      state: "in_progress",
      claim: {
        id: "claim0000001",
        keyId: "key000000001",
        userId: "user00000001",
        username: "casey",
        keyName: "laptop",
        startedAt: 300,
        activeAt: 300,
      },
    }),
  ),
  files: Array.from({ length: MAX_TASK_FILES }, (_, index) => ({
    fileId: `file${String(index).padStart(8, "0")}`,
    name: `${index}`.padEnd(MAX_KNOWLEDGE_NAME, "n"),
    revision: 1_000_000,
    // the widest time an ISO string takes
    changedAt: Date.UTC(275_000, 0),
    deleted: false,
  })),
  chatId: "session00001",
});

export const externalTaskShow = (
  row: ExternalTaskRow = externalTaskRow(),
): TaskShow => ({
  task: externalTaskDetail(row),
  entries: [externalTaskEntry()],
  next: null,
  idleHours: 24,
  createdKeyId: null,
});

export const session = {
  id: "session00001",
  projectId: project.id,
  ownerId: "user00000001",
  agentId: "agent0000001",
  origin: "chat",
  forkedFromId: null,
  automationId: null,
  runSource: null,
  title: "A chat",
  status: "done",
  revision: 2,
  createdAt: 1,
  lastActivityAt: 2,
  usage: null,
  disabledCapabilities: [],
  archived: null,
  attention: null,
  attentionReason: null,
  attentionSource: null,
  attentionBy: null,
} satisfies SessionSummary;

export const row = (id: string, content: string): ExportRow => ({
  id,
  sendId: id,
  round: 1,
  memoryRound: null,
  kind: "user",
  slot: null,
  status: "done",
  error: null,
  finishReason: null,
  nativeFinish: null,
  author: "casey",
  content,
  uploads: null,
  createdAt: 0,
  finishedAt: 0,
});

type TaskCall =
  | { action: "projectOf"; taskId: string }
  | { action: "list"; input: Parameters<TasksPort["list"]>[0] }
  | { action: "show"; taskId: string; before: string | null }
  | { action: "claim"; key: TaskKey; taskId: string }
  | { action: "openLabelCounts"; projectId: string }
  | {
      action: "unclaim";
      key: TaskKey;
      taskId: string;
      claimId: string;
      text: string;
    }
  | {
      action: "report";
      key: TaskKey;
      taskId: string;
      claimId: string;
      kind: string;
      text: string;
      links: string[];
    }
  | { action: "create"; key: TaskKey; projectId: string; body: unknown }
  | { action: "edit"; key: TaskKey; taskId: string; body: unknown }
  | { action: "cancel"; key: TaskKey; taskId: string };

type State = {
  now: number;
  text: string;
  fileName: string;
  revision: number;
  sessionTitle: string;
  reachable: string[];
  listed: KnowledgeFileView[];
  deleted: KnowledgeListResponse["deleted"];
  search: KnowledgeSearchResponse;
  versions: KnowledgeVersion[];
  rows: ExportRow[];
  sessionSearch: SessionSearchPage;
  sessionList: SessionListPage;
  sessionCalls: {
    action: "search" | "list";
    projectId: string;
    q?: string;
    since?: number | null;
    after: string | null;
  }[];
  readError: Error | null;
  checked: number;
  writes: { action: string; author: unknown }[];
  taskProjects: Record<string, string>;
  taskList: {
    rows: (Omit<TaskListRow, "cursor"> & { cursor?: string })[];
    next: string | null;
  };
  taskShow: TaskShow | null;
  taskLabels: { name: string; open: number }[];
  taskClaimId: string;
  taskReport: { entry: ExternalTaskEntry; task: ExternalTaskRow };
  taskCalls: TaskCall[];
};

export function fixture(scope: "read" | "write" = "read", log: Log = silent) {
  const state: State = {
    now: 1,
    text: "hello",
    fileName: "notes/readme.md",
    revision: 7,
    sessionTitle: session.title,
    reachable: [project.id],
    listed: [file("hello")],
    deleted: [],
    search: { names: [], namesTotal: 0, files: [], next: null },
    versions: [],
    rows: [row("message00001", "hello from chat")],
    sessionSearch: { hits: [], next: null },
    sessionList: { sessions: [], next: null },
    sessionCalls: [],
    readError: null,
    checked: 0,
    writes: [],
    taskProjects: { task00000001: project.id },
    taskList: { rows: [{ ...externalTaskRow(), answered: false }], next: null },
    taskShow: externalTaskShow(),
    taskLabels: [
      { name: "build", open: 3 },
      { name: "fix", open: 1 },
      { name: "plan", open: 0 },
    ],
    taskClaimId: "claim0000001",
    taskReport: {
      entry: externalTaskEntry({ kind: "result", claimEnd: "done" }),
      task: externalTaskRow({ state: "done", revision: 2 }),
    },
    taskCalls: [],
  };
  const deps: McpServerDeps = {
    db: memoryDb(),
    clock: () => state.now,
    log,
    version: "test-build",
    access: {
      reachableProjectIds: () => state.reachable,
      checkKey: () => {
        state.checked++;
      },
      project: (_principal, id) => {
        if (!state.reachable.includes(id) || id !== project.id) {
          throw new NotFound();
        }
        return project;
      },
    },
    projects: { byId: (id) => (id === project.id ? project : null) },
    sessions: {
      byId: (id) => {
        if (id !== session.id) return null;
        return { ...session, title: state.sessionTitle };
      },
      exportRows: () => state.rows,
      search: async (projectId, q, after) => {
        state.sessionCalls.push({ action: "search", projectId, q, after });
        return state.sessionSearch;
      },
      list: (projectId, since, after) => {
        state.sessionCalls.push({ action: "list", projectId, since, after });
        return state.sessionList;
      },
    },
    tasks: {
      projectOf: (taskId) => {
        state.taskCalls.push({ action: "projectOf", taskId });
        return state.taskProjects[taskId] ?? null;
      },
      list: (input) => {
        state.taskCalls.push({ action: "list", input });
        return {
          rows: state.taskList.rows.map((row) => ({
            ...row,
            cursor: row.cursor ?? `${row.movedAt}.${row.id}`,
          })),
          next: state.taskList.next,
        };
      },
      openLabelCounts: (projectId) => {
        state.taskCalls.push({ action: "openLabelCounts", projectId });
        return state.taskLabels;
      },
      show: (taskId, before) => {
        state.taskCalls.push({ action: "show", taskId, before });
        return state.taskShow;
      },
      agentUnclaim: (taskKey, taskId, claimId, text) => {
        state.taskCalls.push({
          action: "unclaim",
          key: taskKey,
          taskId,
          claimId,
          text,
        });
        return state.taskReport;
      },
      claim: (taskKey, taskId) => {
        state.taskCalls.push({ action: "claim", key: taskKey, taskId });
        if (state.taskShow === null) throw new NotFound();
        return { ...state.taskShow, claimId: state.taskClaimId };
      },
      agentCreate: (taskKey, projectId, body) => {
        state.taskCalls.push({
          action: "create",
          key: taskKey,
          projectId,
          body,
        });
        if (state.taskShow === null) throw new NotFound();
        return state.taskShow;
      },
      agentEdit: (taskKey, taskId, body) => {
        state.taskCalls.push({ action: "edit", key: taskKey, taskId, body });
        if (state.taskShow === null) throw new NotFound();
        return state.taskShow;
      },
      agentCancel: (taskKey, taskId) => {
        state.taskCalls.push({ action: "cancel", key: taskKey, taskId });
        if (state.taskShow === null) throw new NotFound();
        return state.taskShow;
      },
      report: (taskKey, taskId, claimId, kind, text, links) => {
        state.taskCalls.push({
          action: "report",
          key: taskKey,
          taskId,
          claimId,
          kind,
          text,
          links,
        });
        return state.taskReport;
      },
    },
    knowledge: {
      list: () => ({
        files: state.listed,
        deleted: state.deleted,
        totals: { files: 1, bytes: state.text.length, tokens: 1 },
        limits: { fileBytes: 1, files: 1, projectBytes: 1, historyDays: 1 },
      }),
      projectOf: (kind, id) =>
        id === (kind === "file" ? "file00000001" : "version00001")
          ? project.id
          : null,
      rawFile: (_projectId, id) => {
        if (state.readError !== null) throw state.readError;
        return id === "file00000001"
          ? {
              ...file(state.text),
              name: state.fileName,
              revision: state.revision,
            }
          : null;
      },
      versions: () => state.versions,
      rawVersion: (_projectId, id) => {
        if (id !== "version00001") return null;
        const current = file(state.text);
        return {
          id,
          fileId: current.id,
          name: state.fileName,
          revision: 3,
          bytes: current.bytes,
          lines: current.lines,
          author: current.author,
          writtenAt: 1,
          deleted: false,
          text: current.text,
          language: current.language,
          html: null,
          code: null,
        };
      },
      search: async () => state.search,
      create: (_projectId, author, name) => {
        state.writes.push({ action: "create", author });
        return { ...file(), name, revision: 1 };
      },
      edit: (_projectId, author) => {
        state.writes.push({ action: "edit", author });
        return { ...file(), revision: 8 };
      },
      replace: (_projectId, author) => {
        state.writes.push({ action: "replace", author });
        return { ...file(), revision: 8 };
      },
      rename: (_projectId, author, _id, name) => {
        state.writes.push({ action: "rename", author });
        return { ...file(), name, revision: 8 };
      },
      remove: (_projectId, author) => {
        state.writes.push({ action: "delete", author });
        return { ...file(), revision: 8 };
      },
    },
  };
  const area = mcpServerArea(deps);
  const principal = key(scope);
  const route = (method: string): RouteDescriptor =>
    area.routes.find((item) => item.method === method)!;
  const send = async (req: Request): Promise<Response> =>
    (await route(req.method).handle(req, {
      principal,
      params: {},
      url: new URL(req.url),
      address: "127.0.0.1",
    })) as Response;
  return { area, state, principal, send };
}

export const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};

export function modern(
  method: string,
  params: Record<string, unknown> = {},
  options: { id?: number; name?: string } = {},
): Request {
  const id = options.id === undefined ? 1 : options.id;
  const body = {
    jsonrpc: "2.0",
    ...(id < 0 ? {} : { id }),
    method,
    params: { ...params, _meta: META },
  };
  return new Request("http://1ctx.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(options.name ? { "mcp-name": options.name } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function legacy(body: unknown): Request {
  return new Request("http://1ctx.test/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export const json = async (response: Response) =>
  (await response.json()) as any;

export function soleText(answer: any): string {
  expect(answer.result.content).toHaveLength(1);
  expect(answer.result.content[0].type).toBe("text");
  expect(answer.result.structuredContent).toBeUndefined();
  return answer.result.content[0].text;
}

export function fencedContent(text: string): {
  header: string;
  content: string;
  footer: string;
  fence: string;
} {
  const headerEnd = text.indexOf("\n");
  const openingEnd = text.indexOf("\n", headerEnd + 1);
  const opening = text.slice(headerEnd + 1, openingEnd);
  const fence = opening.slice(0, -4);
  const closing = `\n${fence}\n`;
  const closingAt = text.lastIndexOf(closing);
  const footer = text.slice(closingAt + closing.length);
  let content = text.slice(openingEnd + 1, closingAt + 1);
  if (
    footer.endsWith("The file ends without a newline.") ||
    footer.includes("This page ends mid-line; the next page continues it.")
  ) {
    content = content.slice(0, -1);
  }
  return { header: text.slice(0, headerEnd), content, footer, fence };
}
export async function toolCall(
  send: (req: Request) => Promise<Response>,
  name: string,
  args: unknown,
) {
  return json(
    await send(modern("tools/call", { name, arguments: args }, { name })),
  );
}
