// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type {
  EventOutcome,
  EventSource,
  SessionStatus,
} from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export const MAX_AUTOMATIONS_PER_PROJECT = 20;

type Raw = {
  id: string;
  project_id: string;
  owner_id: string;
  agent_id: string;
  name: string;
  instructions: string;
  schedule: string;
  tz: string;
  deadline_ms: number | null;
  retention_days: number;
  project_memory: number;
  own_memory: number;
  memory_guidance: string;
  disabled_capabilities: string;
  suspended_at: number | null;
  suspended_by: string | null;
  suspended_by_name: string | null;
  owner_name: string;
  next_at: number | null;
  last_event_at: number | null;
  last_event_due_at: number | null;
  last_event_source: EventSource | null;
  last_event_outcome: EventOutcome | null;
  last_event_reason: string | null;
  last_run_session_id: string | null;
  last_run_status: SessionStatus | null;
  revision: number;
  created_at: number;
  updated_at: number;
};

// the row with the usernames of its owner and of whoever suspended it
const SELECT = `select automations.*, owners.username as owner_name,
    suspenders.username as suspended_by_name
  from automations
  join users owners on owners.id = automations.owner_id
  left join users suspenders on suspenders.id = automations.suspended_by`;

const row = (raw: Raw): AutomationSummary => ({
  id: raw.id,
  projectId: raw.project_id,
  ownerId: raw.owner_id,
  ownerName: raw.owner_name,
  agentId: raw.agent_id,
  name: raw.name,
  instructions: raw.instructions,
  schedule: raw.schedule,
  tz: raw.tz,
  deadlineMs: raw.deadline_ms,
  retentionDays: raw.retention_days,
  projectMemory: raw.project_memory === 1,
  ownMemory: raw.own_memory === 1,
  memoryGuidance: raw.memory_guidance,
  disabledCapabilities: JSON.parse(raw.disabled_capabilities),
  suspendedAt: raw.suspended_at,
  suspendedBy:
    raw.suspended_by === null
      ? null
      : { id: raw.suspended_by, username: raw.suspended_by_name ?? "" },
  nextAt: raw.next_at,
  lastEventAt: raw.last_event_at,
  lastEventDueAt: raw.last_event_due_at,
  lastEventSource: raw.last_event_source,
  lastEventOutcome: raw.last_event_outcome,
  lastEventReason: raw.last_event_reason,
  lastRunSessionId: raw.last_run_session_id,
  lastRunStatus: raw.last_run_status,
  revision: raw.revision,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

export type AutomationFields = Pick<
  AutomationSummary,
  | "projectId"
  | "ownerId"
  | "agentId"
  | "name"
  | "instructions"
  | "schedule"
  | "tz"
  | "deadlineMs"
  | "retentionDays"
  | "projectMemory"
  | "ownMemory"
  | "memoryGuidance"
  | "disabledCapabilities"
>;

export class AutomationStore {
  private wakeup: () => void = () => {};

  constructor(private readonly db: Db) {}

  setWake(wake: () => void): void {
    this.wakeup = wake;
  }

  wake(): void {
    this.wakeup();
  }

  byId(id: string): AutomationSummary | null {
    const raw = this.db
      .query<Raw, [string]>(`${SELECT} where automations.id = ?`)
      .get(id);
    return raw ? row(raw) : null;
  }

  byProject(projectId: string): AutomationSummary[] {
    return this.db
      .query<Raw, [string]>(
        `${SELECT} where automations.project_id = ? order by automations.name`,
      )
      .all(projectId)
      .map(row);
  }

  all(): AutomationSummary[] {
    return this.db
      .query<Raw, []>(`${SELECT} order by automations.id`)
      .all()
      .map(row);
  }

  due(now: number): AutomationSummary[] {
    return this.db
      .query<Raw, [number]>(
        `${SELECT} where automations.suspended_at is null and automations.next_at <= ? order by automations.next_at, automations.id`,
      )
      .all(now)
      .map(row);
  }

  earliest(): number | null {
    return this.db
      .query<{ next_at: number | null }, []>(
        "select min(next_at) as next_at from automations where suspended_at is null",
      )
      .get()!.next_at;
  }

  count(projectId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "select count(*) as n from automations where project_id = ?",
      )
      .get(projectId)!.n;
  }

  nameTaken(projectId: string, name: string, exceptId?: string): boolean {
    const raw =
      exceptId === undefined
        ? this.db
            .query<{ n: number }, [string, string]>(
              "select count(*) as n from automations where project_id = ? and name = ?",
            )
            .get(projectId, name)!
        : this.db
            .query<{ n: number }, [string, string, string]>(
              "select count(*) as n from automations where project_id = ? and name = ? and id != ?",
            )
            .get(projectId, name, exceptId)!;
    return raw.n > 0;
  }

  create(
    fields: AutomationFields & { nextAt: number; now: number },
  ): AutomationSummary {
    const id = newId();
    this.db
      .query(
        `insert into automations
          (id, project_id, owner_id, agent_id, name, instructions, schedule,
           tz, deadline_ms, retention_days, project_memory, own_memory,
           memory_guidance, disabled_capabilities,
           next_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.projectId,
        fields.ownerId,
        fields.agentId,
        fields.name,
        fields.instructions,
        fields.schedule,
        fields.tz,
        fields.deadlineMs,
        fields.retentionDays,
        fields.projectMemory ? 1 : 0,
        fields.ownMemory ? 1 : 0,
        fields.memoryGuidance,
        JSON.stringify(fields.disabledCapabilities),
        fields.nextAt,
        fields.now,
        fields.now,
      );
    return this.byId(id)!;
  }

  update(
    id: string,
    fields: Pick<
      AutomationSummary,
      | "agentId"
      | "name"
      | "instructions"
      | "schedule"
      | "tz"
      | "deadlineMs"
      | "retentionDays"
      | "nextAt"
      | "projectMemory"
      | "ownMemory"
      | "memoryGuidance"
      | "disabledCapabilities"
    > & { now: number },
  ): AutomationSummary | null {
    this.db
      .query(
        `update automations set agent_id = ?, name = ?, instructions = ?,
           schedule = ?, tz = ?, deadline_ms = ?, retention_days = ?,
           next_at = ?, project_memory = ?, own_memory = ?, memory_guidance = ?,
           disabled_capabilities = ?,
           revision = revision + 1, updated_at = ? where id = ?`,
      )
      .run(
        fields.agentId,
        fields.name,
        fields.instructions,
        fields.schedule,
        fields.tz,
        fields.deadlineMs,
        fields.retentionDays,
        fields.nextAt,
        fields.projectMemory ? 1 : 0,
        fields.ownMemory ? 1 : 0,
        fields.memoryGuidance,
        JSON.stringify(fields.disabledCapabilities),
        fields.now,
        id,
      );
    return this.byId(id);
  }

  suspend(id: string, by: string, now: number): AutomationSummary | null {
    this.db
      .query(
        `update automations set suspended_at = ?, suspended_by = ?,
           next_at = null, revision = revision + 1, updated_at = ?
         where id = ? and suspended_at is null`,
      )
      .run(now, by, now, id);
    return this.byId(id);
  }

  resume(id: string, nextAt: number, now: number): AutomationSummary | null {
    this.db
      .query(
        `update automations set suspended_at = null, suspended_by = null,
           next_at = ?,
           revision = revision + 1, updated_at = ?
         where id = ? and suspended_at is not null`,
      )
      .run(nextAt, now, id);
    return this.byId(id);
  }

  recordEvent(
    id: string,
    fields: {
      at: number;
      dueAt: number;
      source: EventSource;
      outcome: EventOutcome;
      reason: string | null;
      nextAt?: number | null;
      runSessionId?: string;
    },
  ): AutomationSummary | null {
    if (fields.runSessionId === undefined) {
      if (fields.nextAt === undefined) {
        this.db
          .query(
            `update automations set last_event_at = ?, last_event_due_at = ?,
               last_event_source = ?, last_event_outcome = ?,
               last_event_reason = ?, revision = revision + 1,
               updated_at = ? where id = ?`,
          )
          .run(
            fields.at,
            fields.dueAt,
            fields.source,
            fields.outcome,
            fields.reason,
            fields.at,
            id,
          );
      } else {
        this.db
          .query(
            `update automations set last_event_at = ?, last_event_due_at = ?,
               last_event_source = ?, last_event_outcome = ?,
               last_event_reason = ?, next_at = ?, revision = revision + 1,
               updated_at = ? where id = ?`,
          )
          .run(
            fields.at,
            fields.dueAt,
            fields.source,
            fields.outcome,
            fields.reason,
            fields.nextAt,
            fields.at,
            id,
          );
      }
    } else if (fields.nextAt === undefined) {
      this.db
        .query(
          `update automations set last_event_at = ?, last_event_due_at = ?,
             last_event_source = ?, last_event_outcome = ?,
             last_event_reason = ?, last_run_session_id = ?,
             last_run_status = 'running', revision = revision + 1,
             updated_at = ? where id = ?`,
        )
        .run(
          fields.at,
          fields.dueAt,
          fields.source,
          fields.outcome,
          fields.reason,
          fields.runSessionId,
          fields.at,
          id,
        );
    } else {
      this.db
        .query(
          `update automations set last_event_at = ?, last_event_due_at = ?,
             last_event_source = ?, last_event_outcome = ?,
             last_event_reason = ?, next_at = ?, last_run_session_id = ?,
             last_run_status = 'running', revision = revision + 1,
             updated_at = ? where id = ?`,
        )
        .run(
          fields.at,
          fields.dueAt,
          fields.source,
          fields.outcome,
          fields.reason,
          fields.nextAt,
          fields.runSessionId,
          fields.at,
          id,
        );
    }
    return this.byId(id);
  }

  recordRunEnd(
    id: string,
    sessionId: string,
    status: SessionStatus,
    now: number,
  ): AutomationSummary | null {
    const changed = this.db
      .query(
        `update automations set last_run_status = ?, revision = revision + 1,
           updated_at = ? where id = ? and last_run_session_id = ?
             and last_run_status = 'running'`,
      )
      .run(status, now, id, sessionId).changes;
    return changed > 0 ? this.byId(id) : null;
  }

  delete(id: string): boolean {
    return (
      this.db.query("delete from automations where id = ?").run(id).changes > 0
    );
  }

  usesAgent(agentId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from automations where agent_id = ?",
        )
        .get(agentId)!.n > 0
    );
  }
}
