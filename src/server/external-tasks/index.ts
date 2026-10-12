// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ExternalTaskResponse } from "../../shared/api/external-tasks.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { Principal } from "../lib/http.ts";
import { type KnowledgePort, taskActions } from "./actions.ts";
import { chatTasks } from "./chat.ts";
import type { ClosedFilter } from "./lists.ts";
import { type AccessPort, routes } from "./routes.ts";
import type { ListInput } from "./rows.ts";
import { ExternalTaskStore } from "./store.ts";
import { taskSweeps } from "./sweeps.ts";

export type { KnowledgePort } from "./actions.ts";
export type { TaskKey } from "./rows.ts";
export type { ExternalTaskStore } from "./store.ts";

export type ExternalTasksDeps = {
  db: Db;
  clock: Clock;
  externalTaskIdleHours(): number;
  externalTaskDays(): number;
  knowledge: KnowledgePort;
  access: AccessPort;
  // whether the principal may open the chat, as the chat's own route
  // decides
  chatOpens(principal: Principal, chatId: string): boolean;
  // the projects Home lists marks from: those the principal reaches and
  // belongs to or owns, so an admin is not handed every team's tasks
  homeProjectIds(principal: Principal): string[];
};

export function externalTasksArea(deps: ExternalTasksDeps) {
  const store = new ExternalTaskStore(deps.db);
  // the chat's title only for a viewer who may open the chat
  const show = (
    id: string,
    before: string | null,
    viewer: Principal | null = null,
  ): ExternalTaskResponse | null => {
    const task = store.byId(id);
    if (task === null) return null;
    const { chatTitle, ...brief } = store.brief(id)!;
    const opens =
      viewer !== null &&
      brief.chatId !== null &&
      deps.chatOpens(viewer, brief.chatId);
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
      task: { task, files, ...brief, chatTitle: opens ? chatTitle : null },
      ...store.entries(id, before),
      idleHours: deps.externalTaskIdleHours(),
    };
  };
  const tasks = {
    store,
    projectOf: (id: string) => store.projectOf(id),
    list: (input: ListInput) => store.list(input),
    show,
    byProject: (projectId: string) => ({
      ...store.byProject(projectId),
      idleHours: deps.externalTaskIdleHours(),
    }),
    closed: (
      projectId: string,
      after: string | null,
      filter?: ClosedFilter,
      limit?: number,
    ) => store.closed(projectId, after, limit, filter),
    attention: (projectIds: string[]) => store.attention(projectIds),
    ...taskActions({ ...deps, store, show }),
    ...taskSweeps({ ...deps, store }),
  };
  return {
    ...tasks,
    chat: chatTasks({
      db: deps.db,
      store,
      visibleProjectIds: (userId) => deps.access.visibleProjectIds(userId),
      show,
      actions: tasks,
    }),
    routes: routes({
      db: deps.db,
      access: deps.access,
      homeProjectIds: deps.homeProjectIds,
      tasks,
    }),
  };
}

export type ExternalTasks = ReturnType<typeof externalTasksArea>;
