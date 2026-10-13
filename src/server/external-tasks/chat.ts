// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a chat's external_task tool does: the page's moves as the chat's
// user, bound to the chat's project, so another project's task is not
// found whatever its id.

import type {
  CreateExternalTaskRequest,
  ExternalTaskMoveRequest,
  PatchExternalTaskRequest,
} from "../../shared/api/external-tasks.ts";
import type { ExternalTaskEntry } from "../../shared/contracts/external-task.ts";
import type { ExternalTaskState } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { NotFound } from "../lib/errors.ts";
import type { taskActions } from "./actions.ts";
import type { TaskListRow } from "./rows.ts";
import type { TaskRead } from "./show.ts";
import type { ExternalTaskStore } from "./store.ts";

// the chat's user and project
type ChatActor = { userId: string; projectId: string };

type ChatMove = "answer" | "unclaim" | "cancel" | "reopen";

type ChatDeps = {
  db: Db;
  store: ExternalTaskStore;
  visibleProjectIds(userId: string): string[] | null;
  show(id: string, before: string | null): TaskRead | null;
  actions: ReturnType<typeof taskActions>;
};

export function chatTasks(deps: ChatDeps) {
  const { db, store } = deps;
  // a user removed from the project since the turn began acts no more
  const sees = (actor: ChatActor) => {
    if (!(deps.visibleProjectIds(actor.userId) ?? []).includes(actor.projectId))
      throw new NotFound("no such project");
  };
  const inProject = (actor: ChatActor, id: string) => {
    sees(actor);
    if (store.projectOf(id) !== actor.projectId)
      throw new NotFound("no such external task");
  };
  function write<T>(check: () => void, act: () => T): T {
    return transact(db, () => {
      check();
      return { result: act() };
    });
  }
  return {
    list(
      actor: ChatActor,
      states: ExternalTaskState[],
      after: string | null,
      limit: number,
    ): { rows: TaskListRow[]; next: string | null } {
      sees(actor);
      return store.list({
        projectIds: [actor.projectId],
        states,
        labels: [],
        held: null,
        after,
        limit,
      });
    },
    show(actor: ChatActor, id: string, before: string | null): TaskRead {
      inProject(actor, id);
      return deps.show(id, before)!;
    },
    // the row and the linked ids, without entries
    task(actor: ChatActor, id: string) {
      inProject(actor, id);
      return { row: store.byId(id)!, fileIds: store.fileIds(id) };
    },
    entry(actor: ChatActor, id: string, entryId: string): ExternalTaskEntry {
      inProject(actor, id);
      const entry = store.entry(id, entryId);
      if (entry === null) throw new NotFound("no such entry");
      return entry;
    },
    create: (
      actor: ChatActor,
      body: CreateExternalTaskRequest,
      chatId: string,
    ): TaskRead =>
      write(
        () => sees(actor),
        () => deps.actions.create(actor.userId, actor.projectId, body, chatId),
      ),
    edit: (
      actor: ChatActor,
      id: string,
      body: PatchExternalTaskRequest,
    ): TaskRead =>
      write(
        () => inProject(actor, id),
        () => deps.actions.edit(id, body),
      ),
    move: (
      actor: ChatActor,
      id: string,
      move: ChatMove,
      body: ExternalTaskMoveRequest,
    ): TaskRead =>
      write(
        () => inProject(actor, id),
        () => deps.actions[move](actor.userId, id, body),
      ),
  };
}
