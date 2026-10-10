// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AutomationDraft,
  AutomationProposal,
  DraftState,
} from "../../shared/contracts/automation-draft.ts";
import type { Db } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { DAY_MS } from "../lib/clock.ts";
import { newId } from "../lib/ids.ts";
import { draftChanged, draftsRemoved } from "./draft-events.ts";
import { readDrafts } from "./draft-read.ts";

export type DraftFields = AutomationProposal & {
  sessionId: string;
  sendId: string;
  messageId: string;
  userId: string;
  agentId: string;
  automationId: string | null;
  editRevision: number | null;
  now: number;
};

export type DraftRow = Omit<DraftFields, "now"> & {
  id: string;
  state: DraftState;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAutomationId: string | null;
  runSessionId: string | null;
  createdAt: number;
  expiresAt: number;
};

const COLUMNS = `d.id, d.session_id as sessionId, d.send_id as sendId,
  d.message_id as messageId, d.user_id as userId, d.agent_id as agentId,
  d.action, d.automation_id as automationId, d.edit_revision as editRevision,
  d.fields, d.state, d.decided_by as decidedBy, d.decided_at as decidedAt,
  d.created_automation_id as createdAutomationId,
  d.run_session_id as runSessionId, d.created_at as createdAt,
  d.expires_at as expiresAt`;

type Stored = Omit<DraftRow, "fields"> & { fields: string };
const read = (row: Stored): DraftRow =>
  ({ ...row, fields: JSON.parse(row.fields) }) as DraftRow;

export class AutomationDraftStore {
  constructor(private readonly db: Db) {}

  byId(id: string): DraftRow | null {
    const row = this.db
      .query<Stored, [string]>(
        `select ${COLUMNS} from automation_drafts d where d.id = ?`,
      )
      .get(id);
    return row === null ? null : read(row);
  }

  bySession(sessionId: string): AutomationDraft[] {
    return readDrafts(this.db, "session_id", sessionId).map((row) => row.draft);
  }

  create(input: DraftFields): DraftRow {
    const id = newId();
    this.db
      .query(`insert into automation_drafts
        (id, session_id, send_id, message_id, user_id, agent_id, action,
         automation_id, edit_revision, fields, state, created_at, expires_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(
        id,
        input.sessionId,
        input.sendId,
        input.messageId,
        input.userId,
        input.agentId,
        input.action,
        input.automationId,
        input.editRevision,
        JSON.stringify(input.fields),
        input.now,
        input.now + DAY_MS,
      );
    return this.byId(id)!;
  }

  decide(
    id: string,
    state: Exclude<DraftState, "pending">,
    by: string | null,
    now: number,
    links: { createdAutomationId?: string; runSessionId?: string } = {},
  ): boolean {
    return (
      this.db
        .query(`update automation_drafts
      set state = ?, decided_by = ?, decided_at = ?,
        created_automation_id = ?, run_session_id = ?
      where id = ? and state = 'pending'`)
        .run(
          state,
          by,
          now,
          links.createdAutomationId ?? null,
          links.runSessionId ?? null,
          id,
        ).changes > 0
    );
  }

  removePending(sessionId: string, sendIds: readonly string[]): BusEvent[] {
    const remove = this.db.query<
      { id: string },
      [string, string]
    >(`delete from automation_drafts
      where session_id = ? and send_id = ? and state = 'pending' returning id`);
    const ids = sendIds.flatMap((sendId) =>
      remove.all(sessionId, sendId).map((row) => row.id),
    );
    return draftsRemoved(this.db, sessionId, ids);
  }

  expireSession(sessionId: string, now: number): BusEvent[] {
    return this.db
      .query<{ id: string }, [number, string]>(`update automation_drafts
      set state = 'expired', decided_at = ?
      where session_id = ? and state = 'pending' returning id`)
      .all(now, sessionId)
      .map((row) => draftChanged(this.db, row.id));
  }

  expired(now: number, limit: number): string[] {
    return this.db
      .query<{ id: string }, [number, number]>(
        `select id from automation_drafts where state = 'pending'
       and expires_at <= ? order by expires_at, id limit ?`,
      )
      .all(now, limit)
      .map((row) => row.id);
  }

  expire(id: string, now: number): BusEvent | null {
    const changed =
      this.db
        .query(`update automation_drafts
      set state = 'expired', decided_at = ?
      where id = ? and state = 'pending' and expires_at <= ?`)
        .run(now, id, now).changes > 0;
    return changed ? draftChanged(this.db, id) : null;
  }
}
