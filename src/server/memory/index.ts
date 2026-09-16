// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  SaveMemoryRequest,
  UndoMemoryRequest,
} from "../../shared/api/memory.ts";
import type { Memory } from "../../shared/contracts/memory.ts";
import { MEMORY_CHARS, memoryChars } from "../../shared/memory.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { summary, type UserRow } from "../users/index.ts";
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
  };
  return {
    store,
    ...capability,
    routes: routes({ access: deps.access, memory: capability }),
  };
}

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
  type MemoryWork,
  memoryWork,
  replay,
} from "./store.ts";
