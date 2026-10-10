// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Db, transact } from "../db/index.ts";
import type { AutomationDraftStore } from "./draft-store.ts";

export function draftLifecycle(db: Db, drafts: AutomationDraftStore) {
  return {
    removePending(sessionId: string, sendIds: readonly string[]): void {
      transact(db, () => ({
        result: undefined,
        events: drafts.removePending(sessionId, sendIds),
      }));
    },
    expireSession(sessionId: string, now: number): number {
      return transact(db, () => {
        const events = drafts.expireSession(sessionId, now);
        return { result: events.length, events };
      });
    },
    expire(id: string, now: number): boolean {
      return transact(db, () => {
        const event = drafts.expire(id, now);
        return {
          result: event !== null,
          events: event === null ? [] : [event],
        };
      });
    },
  };
}
