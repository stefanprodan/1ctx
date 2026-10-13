// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A task's read: the detail and a page of entries. The page's routes
// add each entry's Markdown; an agent's and a chat tool's reads keep the
// plain text.

import type { ExternalTaskResponse } from "../../shared/api/external-tasks.ts";
import type {
  ExternalTaskDetail,
  ExternalTaskEntry,
} from "../../shared/contracts/external-task.ts";
import type { Principal } from "../lib/http.ts";
import { renderMarkdown } from "../render/index.ts";
import type { ExternalTaskStore } from "./store.ts";

export type KnowledgePort = {
  file(
    projectId: string,
    fileId: string,
  ): { name: string; revision: number } | null;
  deletedName(projectId: string, fileId: string): string | null;
};

export type TaskRead = {
  task: ExternalTaskDetail;
  entries: ExternalTaskEntry[];
  next: string | null;
  idleHours: number;
};

type ShowDeps = {
  store: ExternalTaskStore;
  knowledge: KnowledgePort;
  externalTaskIdleHours(): number;
  chatOpens(principal: Principal, chatId: string): boolean;
};

// the chat's title only for a viewer who may open the chat
export const taskShow =
  (deps: ShowDeps) =>
  (
    id: string,
    before: string | null,
    viewer: Principal | null = null,
  ): TaskRead | null => {
    const { store } = deps;
    const task = store.byId(id);
    if (task === null) return null;
    const { chatTitle, ...made } = store.made(id)!;
    const opens =
      viewer !== null &&
      made.chatId !== null &&
      deps.chatOpens(viewer, made.chatId);
    const files = store.fileIds(id).map((fileId) => {
      const live = deps.knowledge.file(task.projectId, fileId);
      return {
        fileId,
        name: live?.name ?? deps.knowledge.deletedName(task.projectId, fileId),
        revision: live?.revision ?? null,
        deleted: live === null,
      };
    });
    return {
      task: { task, files, ...made, chatTitle: opens ? chatTitle : null },
      ...store.entries(id, before),
      idleHours: deps.externalTaskIdleHours(),
    };
  };

// rendered once per read, with bare URLs linked
export const forPage = (read: TaskRead): ExternalTaskResponse => ({
  ...read,
  entries: read.entries.map((entry) => ({
    ...entry,
    html: renderMarkdown(entry.text, { autolinks: true }),
  })),
});
