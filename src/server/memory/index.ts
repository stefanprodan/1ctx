// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  SaveMemoryRequest,
  UndoMemoryRequest,
} from "../../shared/api/memory.ts";
import type { Memory, MemoryEntry } from "../../shared/contracts/memory.ts";
import { MEMORY_CHARS, memoryChars } from "../../shared/memory.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { summary, type UserRow } from "../users/index.ts";
import {
  type ChatMemoryEdit,
  chatEdit,
  noteWords,
  savedWords,
} from "./edit.ts";
import { type AccessPort, routes } from "./routes.ts";
import {
  type MemoryCommit,
  type MemoryRow,
  MemoryStore,
  type MemoryTarget,
  type MemoryWork,
  memoryWork,
} from "./store.ts";

export type RunInfoPort = {
  runInfo(sessionId: string): Memory["run"];
};

export type MemoryDeps = {
  db: Db;
  clock: Clock;
  access: AccessPort;
  users: { byId(id: string): UserRow | null };
  runs: RunInfoPort;
};

// what a chat's edit answers the model: the saved words or the refusal
export type ChatEditAnswer = { error: boolean; content: string };

export type MemoryCapability = {
  read(projectId: string, automationId: string | null): Memory;
  work(projectId: string, automationId: string | null): MemoryWork;
  save(
    projectId: string,
    automationId: string | null,
    request: SaveMemoryRequest,
    userId: string,
  ): Memory;
  undo(
    projectId: string,
    automationId: string | null,
    request: UndoMemoryRequest,
    userId: string,
  ): Memory;
  commit(
    work: MemoryWork,
    sessionId: string,
  ): {
    memory: Memory;
    skipped: number;
    skippedOperations: number[];
  };
  // a chat's save to the project's note, at once, in one transaction
  edit(
    projectId: string,
    sessionId: string,
    edit: ChatMemoryEdit,
    userId: string,
  ): ChatEditAnswer;
  // a refusal before any edit, the note listed and so seen whole
  refuse(projectId: string, sessionId: string, reason: string): string;
  // the note a chat's prompt carries, null before its first send and
  // after a summary
  view(sessionId: string): MemoryEntry[] | null;
  // inside the caller's transaction
  startView(sessionId: string, snapshot: readonly MemoryEntry[]): void;
  endView(sessionId: string): void;
};

export type MemoryArea = MemoryCapability & {
  store: MemoryStore;
  routes: RouteDescriptor[];
};

export function memoryArea(deps: MemoryDeps): MemoryArea {
  const store = new MemoryStore(deps.db);
  const target = (
    projectId: string,
    automationId: string | null,
  ): MemoryTarget => ({ projectId, automationId });
  const present = (row: MemoryRow): Memory => ({
    projectId: row.projectId,
    automationId: row.automationId,
    entries: [...row.entries],
    previous: row.previous === null ? null : [...row.previous],
    chars: memoryChars(row.entries),
    limit: MEMORY_CHARS,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy:
      row.updatedBy === null
        ? null
        : (() => {
            const user = deps.users.byId(row.updatedBy);
            return user === null ? null : summary(user);
          })(),
    run: row.sessionId === null ? null : deps.runs.runInfo(row.sessionId),
  });
  const changed = (row: MemoryRow) => ({
    type: "memory.changed" as const,
    data: {
      projectId: row.projectId,
      automationId: row.automationId,
      revision: row.revision,
    },
  });
  const capability: MemoryCapability = {
    read: (projectId, automationId) =>
      present(store.read(target(projectId, automationId))),
    work: (projectId, automationId) =>
      memoryWork(store.read(target(projectId, automationId))),
    save(projectId, automationId, request, userId) {
      return transact(deps.db, () => {
        const row = store.save(
          target(projectId, automationId),
          request.entries,
          request.revision,
          userId,
          deps.clock(),
        );
        return { result: present(row), events: [changed(row)] };
      });
    },
    undo(projectId, automationId, request, userId) {
      return transact(deps.db, () => {
        const row = store.undo(
          target(projectId, automationId),
          request.revision,
          userId,
          deps.clock(),
        );
        return { result: present(row), events: [changed(row)] };
      });
    },
    commit(work, sessionId) {
      return transact(deps.db, () => {
        const committed: MemoryCommit = store.commit(
          work,
          sessionId,
          deps.clock(),
        );
        return {
          result: {
            memory: present(committed.row),
            skipped: committed.skipped,
            skippedOperations: committed.skippedOperations,
          },
          events: committed.changed ? [changed(committed.row)] : [],
        };
      });
    },
    edit(projectId, sessionId, edit, userId) {
      return transact<ChatEditAnswer>(deps.db, () => {
        const note = target(projectId, null);
        const current = store.read(note);
        const view = store.view(sessionId);
        const outcome = chatEdit(
          current.entries,
          view?.seen ?? current.entries,
          edit,
        );
        store.setSeen(
          sessionId,
          outcome.seen,
          view?.snapshot ?? current.entries,
        );
        if (!outcome.ok) {
          return {
            result: {
              error: true,
              content: noteWords(outcome.reason, current.entries),
            },
          };
        }
        if (!outcome.changed) {
          return {
            result: { error: false, content: savedWords(current.entries) },
          };
        }
        const row = store.saveFromChat(
          note,
          current,
          outcome.entries,
          userId,
          sessionId,
          deps.clock(),
        );
        return {
          result: { error: false, content: savedWords(row.entries) },
          events: [changed(row)],
        };
      });
    },
    refuse(projectId, sessionId, reason) {
      return transact(deps.db, () => {
        const current = store.read(target(projectId, null));
        const view = store.view(sessionId);
        store.setSeen(
          sessionId,
          current.entries,
          view?.snapshot ?? current.entries,
        );
        return { result: noteWords(reason, current.entries) };
      });
    },
    view: (sessionId) => store.view(sessionId)?.snapshot ?? null,
    startView: (sessionId, snapshot) => store.startView(sessionId, snapshot),
    endView: (sessionId) => store.endView(sessionId),
  };
  return {
    store,
    ...capability,
    routes: routes({ access: deps.access, memory: capability }),
  };
}

export {
  type ChatEditOutcome,
  type ChatMemoryEdit,
  chatEdit,
  noteWords,
  savedWords,
} from "./edit.ts";
export {
  MAX_MEMORY_BODY,
  parseSaveMemory,
  parseUndoMemory,
} from "./parse.ts";
export { type AccessPort, type RoutesDeps, routes } from "./routes.ts";
export {
  type MemoryCommit,
  type MemoryOperation,
  type MemoryRow,
  MemoryStore,
  type MemoryTarget,
  type MemoryView,
  type MemoryWork,
  memoryWork,
  replay,
} from "./store.ts";
