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
  isAgentEntryKind,
} from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import type { TaskKey } from "./rows.ts";
import {
  type Brief,
  checkBrief,
  checkClaims,
  checkEntry,
  checkKeyUnfinished,
  checkMove,
  checkRoom,
  checkUnfinished,
  closed,
  isState,
  limitNote,
  NEW_TASK,
  NOT_KEY_TODO,
  roomFor,
} from "./rules.ts";
import type { KnowledgePort, TaskRead } from "./show.ts";
import type { ExternalTaskStore, StoredBrief } from "./store.ts";
import { required, taskChanged, writeEntry } from "./writes.ts";

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
  // the claim's own entry: a report, or the agent giving the task back.
  // A report past the entry bounds ends the claim as limit and commits that
  // before the refusal is thrown, so the page shows why it went back.
  const agentEntry = (
    key: TaskKey,
    taskId: string,
    claimId: string,
    kind: AgentEntryKind | "unclaim",
    text: string,
    links: string[],
  ) => {
    const written = transact(db, () => {
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
      checkMove(task.state, kind, "agent");
      checkEntry(kind, text, links);
      const entries = store.counted(taskId);
      if (!roomFor(entries, kind)) {
        const released = writeEntry(store, task, {
          actor: "limit",
          kind: "unclaim",
          text: limitNote(entries),
          links: [],
          userId: null,
          at: deps.clock(),
        });
        return { result: null, events: [taskChanged(released.task)] };
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
    if (written === null) throw new Conflict(NEW_TASK);
    return written;
  };
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

  // a todo task never holds a claim, so a key's own todo task is one
  // no agent works on yet
  const keyTodo = (key: TaskKey, id: string) => {
    const task = required(store, id);
    if (store.createdKey(id) !== key.keyId || task.state !== "todo")
      throw new Conflict(NOT_KEY_TODO);
    return task;
  };
  // the brief's change and its edit entry, inside the caller's
  // transaction; a key's edit names the key and meets the bounds
  const rebrief = (
    task: ExternalTaskRow,
    body: PatchExternalTaskRequest,
    userId: string,
    key: TaskKey | null,
    viewer: Principal | null,
    chatId: string | null,
  ) => {
    const id = task.id;
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
    if (key !== null) checkRoom(store.counted(id), "edit");
    const now = deps.clock();
    store.edit(id, brief, now);
    store.append(id, {
      claimId: null,
      kind: "edit",
      text: "",
      links: [],
      userId,
      keyName: key?.keyName ?? null,
      claimEnd: null,
      chatId,
      at: now,
    });
    const result = detail(id, viewer);
    return { result, events: [taskChanged(result.task.task)] };
  };

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
    // a member's or the chat user's edit: an entry with no text that
    // never counts toward the bounds, as an agent's over /mcp does
    edit: (
      userId: string,
      id: string,
      body: PatchExternalTaskRequest,
      viewer: Principal | null = null,
      chatId: string | null = null,
    ) =>
      transact(db, () => {
        const task = required(store, id);
        if (task.editRevision !== body.editRevision)
          throw new Conflict(STALE_TASK);
        if (closed(task.state)) throw new Conflict(isState(task.state));
        return rebrief(task, body, userId, null, viewer, chatId);
      }),
    // an outside agent's task over /mcp, its key recorded. A retry
    // answers the task the key made of that title while it is
    // unfinished, so a lost answer makes no second task
    agentCreate(
      key: TaskKey,
      projectId: string,
      body: CreateExternalTaskRequest,
    ) {
      return transact(db, () => {
        const first = store.keyUnfinishedTitled(
          key.keyId,
          projectId,
          body.title.trim(),
        );
        if (first !== null) return { result: detail(first) };
        const brief = stored(projectId, body);
        checkUnfinished(store.unfinishedCount(projectId));
        checkKeyUnfinished(store.keyUnfinishedCount(key.keyId));
        const id = store.create(
          projectId,
          key.userId,
          brief,
          deps.clock(),
          null,
          key,
        );
        const result = detail(id);
        return { result, events: [taskChanged(result.task.task)] };
      });
    },
    // the key's own task before a claim: its edit carries the key's
    // name, so the bounds count it, and is refused past them
    agentEdit: (key: TaskKey, id: string, body: PatchExternalTaskRequest) =>
      transact(db, () => {
        const task = keyTodo(key, id);
        if (task.editRevision !== body.editRevision)
          throw new Conflict(STALE_TASK);
        return rebrief(task, body, key.userId, key, null, null);
      }),
    // the key's own task before a claim; ending it always lands
    agentCancel: (key: TaskKey, id: string) =>
      transact(db, () => {
        const task = keyTodo(key, id);
        const state = checkMove(task.state, "cancel", "member");
        const now = deps.clock();
        store.append(id, {
          claimId: null,
          kind: "cancel",
          text: "",
          links: [],
          userId: key.userId,
          keyName: key.keyName,
          claimEnd: null,
          at: now,
        });
        store.move(id, state, null, now);
        const result = detail(id);
        return { result, events: [taskChanged(result.task.task)] };
      }),
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
