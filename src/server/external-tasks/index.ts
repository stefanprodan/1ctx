// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ExternalTaskResponse } from "../../shared/api/external-tasks.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { type KnowledgePort, taskActions } from "./actions.ts";
import { chatTasks } from "./chat.ts";
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
};

export function externalTasksArea(deps: ExternalTasksDeps) {
  const store = new ExternalTaskStore(deps.db);
  const show = (
    id: string,
    before: string | null,
  ): ExternalTaskResponse | null => {
    const task = store.byId(id);
    if (task === null) return null;
    const brief = store.brief(id)!;
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
      task: { task, files, ...brief },
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
    closed: (projectId: string, after: string | null, limit?: number) =>
      store.closed(projectId, after, limit),
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
    routes: routes({ db: deps.db, access: deps.access, tasks }),
  };
}

export type ExternalTasks = ReturnType<typeof externalTasksArea>;
