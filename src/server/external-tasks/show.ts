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
  ): { name: string; revision: number; updatedAt: number } | null;
  deletedName(projectId: string, fileId: string): string | null;
};

export type TaskRead = {
  task: ExternalTaskDetail;
  entries: ExternalTaskEntry[];
  next: string | null;
  idleHours: number;
  // the key that made it over /mcp, so that key's read says so; never
  // on the page's
  createdKeyId: string | null;
};

type ShowDeps = {
  store: ExternalTaskStore;
  knowledge: KnowledgePort;
  externalTaskIdleHours(): number;
  chatOpens(principal: Principal, chatId: string): boolean;
};

// a chat's title, the task's and an edit's, only for a viewer who may
// open the chat, asked once per chat
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
    const asked = new Map<string, boolean>();
    const titled = (chatId: string | null, title: string | null) => {
      if (viewer === null || chatId === null) return null;
      let opens = asked.get(chatId);
      if (opens === undefined) {
        opens = deps.chatOpens(viewer, chatId);
        asked.set(chatId, opens);
      }
      return opens ? title : null;
    };
    const { chatTitle, createdKeyId, ...made } = store.made(id)!;
    const files = store.fileIds(id).map((fileId) => {
      const live = deps.knowledge.file(task.projectId, fileId);
      return {
        fileId,
        name: live?.name ?? deps.knowledge.deletedName(task.projectId, fileId),
        revision: live?.revision ?? null,
        changedAt: live?.updatedAt ?? null,
        deleted: live === null,
      };
    });
    const page = store.entries(id, before);
    return {
      task: { task, files, ...made, chatTitle: titled(made.chatId, chatTitle) },
      entries: page.entries.map((entry) => ({
        ...entry,
        chatTitle: titled(entry.chatId, entry.chatTitle),
      })),
      next: page.next,
      idleHours: deps.externalTaskIdleHours(),
      createdKeyId,
    };
  };

// rendered once per read, with bare URLs and the task project's
// knowledge paths linked
export const forPage = ({
  createdKeyId: _,
  ...read
}: TaskRead): ExternalTaskResponse => ({
  ...read,
  entries: read.entries.map((entry) => ({
    ...entry,
    html: renderMarkdown(entry.text, {
      autolinks: true,
      project: read.task.task.projectId,
    }),
  })),
});
