// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateExternalTaskRequest,
  ExternalTaskMoveRequest,
  ExternalTaskResponse,
  ExternalTaskSeenRequest,
  PatchExternalTaskRequest,
} from "../../shared/api/external-tasks.ts";
import {
  type ExternalTaskRow,
  STALE_TASK,
} from "../../shared/contracts/external-task.ts";
import type {
  AgentEntryKind,
  ClaimEnd,
  EntryKind,
} from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import type { TaskKey } from "./rows.ts";
import {
  type Actor,
  type Brief,
  checkBrief,
  checkClaims,
  checkEntry,
  checkMove,
  checkRoom,
  checkUnfinished,
  closed,
} from "./rules.ts";
import type { ExternalTaskStore } from "./store.ts";

export type KnowledgePort = {
  file(
    projectId: string,
    fileId: string,
  ): { name: string; revision: number } | null;
  deletedName(projectId: string, fileId: string): string | null;
};

export const taskChanged = (task: ExternalTaskRow): BusEvent => ({
  type: "externalTask.changed",
  data: { projectId: task.projectId, task },
});

export function required(
  store: ExternalTaskStore,
  id: string,
): ExternalTaskRow {
  const task = store.byId(id);
  if (task === null) throw new NotFound("no such external task");
  return task;
}

export function writeEntry(
  store: ExternalTaskStore,
  task: ExternalTaskRow,
  input: {
    actor: Actor;
    kind: EntryKind;
    text: string;
    links: string[];
    userId: string | null;
    at: number;
  },
) {
  const { actor, kind, text, links, userId, at } = input;
  const state = checkMove(task.state, kind, actor);
  checkEntry(kind, text, links);
  checkRoom(store.counted(task.id), kind);
  const end: ClaimEnd | null =
    kind === "result"
      ? "done"
      : kind === "drop" && task.claim !== null
        ? "dropped"
        : kind === "release"
          ? actor === "idle" || actor === "access_gone"
            ? actor
            : "released"
          : null;
  const claim = task.claim;
  if (claim !== null) {
    store.active(claim.id, at);
    if (end !== null) store.endClaim(claim.id, end, at);
  }
  const id = store.append(task.id, {
    kind,
    text,
    links,
    userId,
    at,
    claimId: actor === "agent" || end !== null ? (claim?.id ?? null) : null,
    keyName: actor === "agent" ? claim!.keyName : null,
    claimEnd: end,
  });
  const marked =
    kind === "question" ||
    kind === "result" ||
    (kind === "release" && actor !== "member");
  store.move(
    task.id,
    state,
    end === null ? (claim?.id ?? null) : null,
    actor === "member" ? null : marked ? at : task.attentionAt,
    at,
  );
  const row = required(store, task.id);
  if (actor === "agent") store.remember(claim!.id, row);
  return { entry: store.entry(task.id, id)!, task: row };
}

type ActionsDeps = {
  db: Db;
  clock: Clock;
  store: ExternalTaskStore;
  knowledge: KnowledgePort;
  show(id: string, before: string | null): ExternalTaskResponse | null;
};

export function taskActions(deps: ActionsDeps) {
  const { db, store } = deps;
  const detail = (id: string) => {
    const found = deps.show(id, null);
    if (found === null) throw new NotFound("no such external task");
    return found;
  };
  const files = (projectId: string, ids: string[], kept: string[] = []) => {
    for (const id of ids) {
      if (!kept.includes(id) && deps.knowledge.file(projectId, id) === null) {
        throw new BadRequest("no such knowledge file");
      }
    }
  };
  const member = (
    userId: string,
    id: string,
    kind: "answer" | "release" | "drop" | "reopen",
    body: ExternalTaskMoveRequest,
  ) =>
    transact(db, () => {
      const task = required(store, id);
      if (task.state !== body.state) throw new Conflict(STALE_TASK);
      // release names its claim; an answer or drop may, and is held to it
      if (
        (kind === "release" ||
          (kind !== "reopen" && body.claimId !== undefined)) &&
        (task.claim === null || task.claim.id !== body.claimId)
      ) {
        throw new Conflict(STALE_TASK);
      }
      checkMove(task.state, kind, "member");
      if (kind === "reopen")
        checkUnfinished(store.unfinishedCount(task.projectId));
      const result = writeEntry(store, task, {
        actor: "member",
        kind,
        userId,
        text: body.text ?? "",
        links: [],
        at: deps.clock(),
      });
      return { result: detail(id), events: [taskChanged(result.task)] };
    });

  return {
    create(
      userId: string,
      projectId: string,
      body: CreateExternalTaskRequest,
      chatId: string | null = null,
    ) {
      return transact(db, () => {
        const brief = { ...body, part: body.part ?? null };
        checkBrief(brief);
        brief.title = brief.title.trim();
        files(projectId, brief.fileIds);
        checkUnfinished(store.unfinishedCount(projectId));
        const id = store.create(projectId, userId, brief, deps.clock(), chatId);
        const result = detail(id);
        return { result, events: [taskChanged(result.task.task)] };
      });
    },
    edit(id: string, body: PatchExternalTaskRequest) {
      return transact(db, () => {
        const task = required(store, id);
        if (task.editRevision !== body.editRevision)
          throw new Conflict(STALE_TASK);
        if (closed(task.state))
          throw new Conflict(`this task is ${task.state}`);
        const old: Brief = {
          title: task.title,
          text: store.brief(id)!.text,
          part: task.part,
          fileIds: store.fileIds(id),
        };
        const brief: Brief = {
          title: body.title ?? old.title,
          text: body.text ?? old.text,
          part: body.part === undefined ? old.part : body.part,
          fileIds: body.fileIds ?? old.fileIds,
        };
        checkBrief(brief);
        brief.title = brief.title.trim();
        files(task.projectId, brief.fileIds, old.fileIds);
        if (JSON.stringify(brief) === JSON.stringify(old))
          return { result: detail(id) };
        store.edit(id, brief, deps.clock());
        const result = detail(id);
        return { result, events: [taskChanged(result.task.task)] };
      });
    },
    answer: (userId: string, id: string, body: ExternalTaskMoveRequest) =>
      member(userId, id, "answer", body),
    release: (userId: string, id: string, body: ExternalTaskMoveRequest) =>
      member(userId, id, "release", body),
    drop: (userId: string, id: string, body: ExternalTaskMoveRequest) =>
      member(userId, id, "drop", body),
    reopen: (userId: string, id: string, body: ExternalTaskMoveRequest) =>
      member(userId, id, "reopen", body),
    seen(id: string, body: ExternalTaskSeenRequest) {
      return transact(db, () => {
        required(store, id);
        if (!store.seen(id, body.attentionAt)) return { result: detail(id) };
        const result = detail(id);
        return { result, events: [taskChanged(result.task.task)] };
      });
    },
    delete(id: string) {
      return transact(db, () => {
        const task = required(store, id);
        store.delete(id);
        return {
          result: undefined,
          events: [
            {
              type: "externalTask.deleted",
              data: { projectId: task.projectId, taskId: id },
            },
          ],
        };
      });
    },
    claim(key: TaskKey, id: string) {
      return transact(db, () => {
        const task = required(store, id);
        if (task.claim !== null) {
          const claim = store.claimById(task.claim.id)!;
          if (claim.key_id === key.keyId && claim.user_id === key.userId) {
            return { result: { ...detail(id), claimId: claim.id } };
          }
          throw new Conflict("this task is already claimed");
        }
        checkMove(task.state, "claim", "agent");
        checkRoom(store.counted(id), "claim");
        checkClaims(store.claimsCount(id));
        const now = deps.clock();
        const claimId = store.startClaim(id, key, now);
        store.append(id, {
          claimId,
          kind: "claim",
          text: "",
          links: [],
          userId: key.userId,
          keyName: key.keyName,
          claimEnd: null,
          at: now,
        });
        store.move(id, "claimed", claimId, task.attentionAt, now);
        const result = { ...detail(id), claimId };
        return { result, events: [taskChanged(result.task.task)] };
      });
    },
    report(
      key: TaskKey,
      taskId: string,
      claimId: string,
      kind: AgentEntryKind,
      text: string,
      links: string[],
    ) {
      return transact(db, () => {
        const claim = store.claimById(claimId);
        if (claim === null) throw new NotFound("no such external task");
        if (
          claim.task_id !== taskId ||
          claim.key_id !== key.keyId ||
          claim.user_id !== key.userId
        ) {
          throw new Conflict(STALE_TASK);
        }
        const task = required(store, taskId);
        const last = store.lastEntry(claimId, claim.ended_at === null);
        const identical =
          last !== null &&
          last.kind === kind &&
          last.text === text &&
          JSON.stringify(last.links) === JSON.stringify(links);
        const endedByReport =
          (kind === "result" && claim.end_reason === "done") ||
          (kind === "release" && claim.end_reason === "released");
        if (
          (identical && claim.ended_at === null) ||
          (endedByReport && last?.kind === kind && last.keyName !== null)
        ) {
          if (claim.last_task === null)
            throw new Error("missing task retry row");
          const previous: ExternalTaskRow = JSON.parse(claim.last_task);
          return { result: { entry: last, task: previous } };
        }
        if (claim.ended_at !== null || task.claim?.id !== claimId) {
          throw new Conflict(STALE_TASK);
        }
        const result = writeEntry(store, task, {
          actor: "agent",
          kind,
          text,
          links,
          userId: key.userId,
          at: deps.clock(),
        });
        return { result, events: [taskChanged(result.task)] };
      });
    },
  };
}
