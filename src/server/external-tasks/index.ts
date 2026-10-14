// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { Principal } from "../lib/http.ts";
import { taskActions } from "./actions.ts";
import { chatTasks } from "./chat.ts";
import type { ClosedFilter } from "./lists.ts";
import { type AccessPort, routes } from "./routes.ts";
import type { ListInput } from "./rows.ts";
import { type KnowledgePort, taskShow } from "./show.ts";
import { ExternalTaskStore } from "./store.ts";
import { taskSweeps } from "./sweeps.ts";

export type { TaskKey } from "./rows.ts";
export type { KnowledgePort, TaskRead } from "./show.ts";
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
  // the projects Home lists waiting tasks from: those the principal
  // reaches and belongs to or owns, so an admin is not handed every
  // team's tasks
  homeProjectIds(principal: Principal): string[];
};

export function externalTasksArea(deps: ExternalTasksDeps) {
  const store = new ExternalTaskStore(deps.db);
  const show = taskShow({ ...deps, store });
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
    waiting: (projectIds: string[]) => store.waiting(projectIds),
    // the line an agent's first list page of a project ends with
    openLabelCounts: (projectId: string) => store.openLabelCounts(projectId),
    // the label task counts the project's detail carries
    labelTasks: (projectId: string) => store.labelTasks(projectId),
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
