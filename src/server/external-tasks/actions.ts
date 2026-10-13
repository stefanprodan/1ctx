// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateExternalTaskRequest,
  ExternalTaskMoveRequest,
  PatchExternalTaskRequest,
} from "../../shared/api/external-tasks.ts";
import {
  type ExternalTaskRow,
  STALE_TASK,
} from "../../shared/contracts/external-task.ts";
import { shapeLabelName } from "../../shared/contracts/label.ts";
import {
  AGENT_ENTRY_KINDS,
  type AgentEntryKind,
  type ClaimEnd,
  type EntryKind,
  isAgentEntryKind,
} from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
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
  isState,
} from "./rules.ts";
import type { KnowledgePort, TaskRead } from "./show.ts";
import type { ExternalTaskStore, StoredBrief } from "./store.ts";

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
      : kind === "cancel" && task.claim !== null
        ? "canceled"
        : kind === "unclaim"
          ? actor === "idle" || actor === "access_gone"
            ? actor
            : "unclaimed"
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
  // a question asked again restarts the wait Home orders by
  store.move(
    task.id,
    state,
    end === null ? (claim?.id ?? null) : null,
    at,
    kind === "question",
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
  show(
    id: string,
    before: string | null,
    viewer?: Principal | null,
  ): TaskRead | null;
};

// a route's moves answer the detail its viewer may read
export function taskActions(deps: ActionsDeps) {
  const { db, store } = deps;
  const detail = (id: string, viewer: Principal | null = null) => {
    const found = deps.show(id, null, viewer);
    if (found === null) throw new NotFound("no such external task");
    return found;
  };
  // the brief as stored: a new file link names a live file of the
  // project, a kept one may name a file deleted since; every label is
  // one of the project's, by its shaped name
  const stored = (
    projectId: string,
    brief: Brief,
    kept: string[] = [],
  ): StoredBrief => {
    checkBrief(brief);
    for (const id of brief.fileIds) {
      if (!kept.includes(id) && deps.knowledge.file(projectId, id) === null) {
        throw new BadRequest("no such knowledge file");
      }
    }
    const names = brief.labels.map(shapeLabelName);
    const ids = store.projectLabels(projectId, names);
    const labelIds = names.map((name) => ids.get(name));
    if (labelIds.some((id) => id === undefined)) {
      throw new BadRequest("labels must name this project's labels");
    }
    return {
      title: brief.title.trim(),
      labelIds: labelIds as string[],
      fileIds: brief.fileIds,
    };
  };
  // the claim's own entry: a report, or the agent giving the task back
  const agentEntry = (
    key: TaskKey,
    taskId: string,
    claimId: string,
    kind: AgentEntryKind | "unclaim",
    text: string,
    links: string[],
  ) =>
    transact(db, () => {
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
      const endedByAgent =
        (kind === "result" && claim.end_reason === "done") ||
        (kind === "unclaim" && claim.end_reason === "unclaimed");
      if (
        (identical && claim.ended_at === null) ||
        (endedByAgent && last?.kind === kind && last.keyName !== null)
      ) {
        if (claim.last_task === null) throw new Error("missing task retry row");
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
  const member = (
    userId: string,
    id: string,
    kind: "answer" | "unclaim" | "cancel" | "reopen",
    body: ExternalTaskMoveRequest,
    viewer: Principal | null,
  ) =>
    transact(db, () => {
      const task = required(store, id);
      if (task.state !== body.state) throw new Conflict(STALE_TASK);
      // unclaim names its claim; an answer or cancel may, and is held to it
      if (
        (kind === "unclaim" ||
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
      return {
        result: detail(id, viewer),
        events: [taskChanged(result.task)],
      };
    });

  return {
    create(
      userId: string,
      projectId: string,
      body: CreateExternalTaskRequest,
      chatId: string | null = null,
    ) {
      return transact(db, () => {
        const brief = stored(projectId, body);
        checkUnfinished(store.unfinishedCount(projectId));
        const id = store.create(projectId, userId, brief, deps.clock(), chatId);
        const result = detail(id);
        return { result, events: [taskChanged(result.task.task)] };
      });
    },
    edit(
      id: string,
      body: PatchExternalTaskRequest,
      viewer: Principal | null = null,
    ) {
      return transact(db, () => {
        const task = required(store, id);
        if (task.editRevision !== body.editRevision)
          throw new Conflict(STALE_TASK);
        if (closed(task.state)) throw new Conflict(isState(task.state));
        const old: StoredBrief = {
          title: task.title,
          labelIds: store.labelIds(id),
          fileIds: store.fileIds(id),
        };
        // a task whose labels were all deleted takes one at its next edit
        const brief = stored(
          task.projectId,
          {
            title: body.title ?? old.title,
            labels: body.labels ?? task.labels,
            fileIds: body.fileIds ?? old.fileIds,
          },
          old.fileIds,
        );
        if (JSON.stringify(brief) === JSON.stringify(old))
          return { result: detail(id, viewer) };
        store.edit(id, brief, deps.clock());
        const result = detail(id, viewer);
        return { result, events: [taskChanged(result.task.task)] };
      });
    },
    answer: (
      userId: string,
      id: string,
      body: ExternalTaskMoveRequest,
      viewer: Principal | null = null,
    ) => member(userId, id, "answer", body, viewer),
    unclaim: (
      userId: string,
      id: string,
      body: ExternalTaskMoveRequest,
      viewer: Principal | null = null,
    ) => member(userId, id, "unclaim", body, viewer),
    cancel: (
      userId: string,
      id: string,
      body: ExternalTaskMoveRequest,
      viewer: Principal | null = null,
    ) => member(userId, id, "cancel", body, viewer),
    reopen: (
      userId: string,
      id: string,
      body: ExternalTaskMoveRequest,
      viewer: Principal | null = null,
    ) => member(userId, id, "reopen", body, viewer),
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
        checkClaims(store.claimsSinceReopen(id));
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
        store.move(id, "in_progress", claimId, now);
        const result = { ...detail(id), claimId };
        return { result, events: [taskChanged(result.task.task)] };
      });
    },
    // a retry of the same report answers the first; report never gives
    // a task back, unclaim does
    report(
      key: TaskKey,
      taskId: string,
      claimId: string,
      kind: AgentEntryKind,
      text: string,
      links: string[],
    ) {
      if (!isAgentEntryKind(kind)) {
        throw new BadRequest(
          `kind must be one of ${AGENT_ENTRY_KINDS.join(", ")}`,
        );
      }
      return agentEntry(key, taskId, claimId, kind, text, links);
    },
    // the claim's key gives the task back with a note; a retry answers
    // the first unclaim, even after later entries
    agentUnclaim: (
      key: TaskKey,
      taskId: string,
      claimId: string,
      text: string,
    ) => agentEntry(key, taskId, claimId, "unclaim", text, []),
  };
}
