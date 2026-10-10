// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import type {
  AttentionMode,
  EventOutcome,
  EventSource,
  SessionStatus,
} from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import {
  alertColumns,
  alertOf,
  forgetCapabilityIn,
  type RawAlert,
} from "../sessions/index.ts";

export const MAX_AUTOMATIONS_PER_PROJECT = 20;

type Raw = RawAlert & {
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
  own_memory: number;
  memory_guidance: string;
  attention_mode: AttentionMode;
  attention_guidance: string;
  disabled_capabilities: string;
  rerun_on_restart: number;
  once: number;
  once_fired_at: number | null;
  once_run_session_id: string | null;
  suspended_at: number | null;
  suspended_by: string | null;
  suspended_by_name: string | null;
  owner_name: string;
  agent_name: string;
  agent_retired: number;
  next_at: number | null;
  last_event_at: number | null;
  last_event_due_at: number | null;
  last_event_source: EventSource | null;
  last_event_outcome: EventOutcome | null;
  last_event_reason: string | null;
  last_run_session_id: string | null;
  last_run_status: SessionStatus | null;
  revision: number;
  edit_revision: number;
  created_at: number;
  updated_at: number;
};

// resume, run now and an edit that keeps the agent wait for a live pick
export const RETIRED = "its agent was deleted";

// the row with the usernames of its owner and of whoever suspended it,
// and its agent's name, a retired one included
const SELECT = `select automations.*, owners.username as owner_name,
    suspenders.username as suspended_by_name,
    agents.name as agent_name,
    agents.deleted_at is not null as agent_retired,
    ${alertColumns("automations")}
  from automations
  join users owners on owners.id = automations.owner_id
  join agents on agents.id = automations.agent_id
  left join users suspenders on suspenders.id = automations.suspended_by`;

const row = (raw: Raw): AutomationSummary => ({
  id: raw.id,
  projectId: raw.project_id,
  ownerId: raw.owner_id,
  ownerName: raw.owner_name,
  agentId: raw.agent_id,
  agentName: raw.agent_name,
  agentRetired: raw.agent_retired === 1,
  name: raw.name,
  instructions: raw.instructions,
  schedule: raw.schedule,
  tz: raw.tz,
  deadlineMs: raw.deadline_ms,
  retentionDays: raw.retention_days,
  ownMemory: raw.own_memory === 1,
  memoryGuidance: raw.memory_guidance,
  attentionMode: raw.attention_mode,
  attentionGuidance: raw.attention_guidance,
  alert: alertOf(raw),
  disabledCapabilities: JSON.parse(raw.disabled_capabilities),
  rerunOnRestart: raw.rerun_on_restart === 1,
  once: raw.once === 1,
  onceFiredAt: raw.once_fired_at,
  onceRunSessionId: raw.once_run_session_id,
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
  editRevision: raw.edit_revision,
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
  | "ownMemory"
  | "memoryGuidance"
  | "attentionMode"
  | "attentionGuidance"
  | "disabledCapabilities"
  | "rerunOnRestart"
  | "once"
>;

export type AutomationEdit = Omit<AutomationFields, "projectId"> & {
  nextAt: number | null;
  now: number;
};

// a fire's outcome; a run names its session and a schedule moves next_at
export type EventFields = {
  at: number;
  dueAt: number;
  source: EventSource;
  outcome: EventOutcome;
  reason: string | null;
  nextAt?: number;
  runSessionId?: string;
};

export const automationChanged = (automation: AutomationSummary) => ({
  type: "automation.changed" as const,
  data: { projectId: automation.projectId, automation },
});

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

  // with after, only the fires due past it: a waiting row is not a wake
  earliest(after: number | null = null): number | null {
    return this.db
      .query<{ next_at: number | null }, [number | null, number | null]>(
        "select min(next_at) as next_at from automations where suspended_at is null and (? is null or next_at > ?)",
      )
      .get(after, after)!.next_at;
  }

  // every row, and those not suspended whose fire was due by dueBy
  tally(dueBy: number): { total: number; waiting: number } {
    return this.db
      .query<{ total: number; waiting: number }, [number]>(
        `select count(*) as total,
                coalesce(sum(suspended_at is null and next_at <= ?), 0) as waiting
           from automations`,
      )
      .get(dueBy)!;
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
           tz, deadline_ms, retention_days, own_memory,
           memory_guidance, attention_mode, attention_guidance,
           disabled_capabilities, rerun_on_restart, once,
           next_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        fields.ownMemory ? 1 : 0,
        fields.memoryGuidance,
        fields.attentionMode,
        fields.attentionGuidance,
        JSON.stringify(fields.disabledCapabilities),
        fields.rerunOnRestart ? 1 : 0,
        fields.once ? 1 : 0,
        fields.nextAt,
        fields.now,
        fields.now,
      );
    return this.byId(id)!;
  }

  // a save that changed a field: its editor owns the row from now on
  update(id: string, fields: AutomationEdit): AutomationSummary | null {
    this.db
      .query(
        `update automations set owner_id = ?, agent_id = ?, name = ?,
           instructions = ?,
           schedule = ?, tz = ?, deadline_ms = ?, retention_days = ?,
           next_at = ?, own_memory = ?, memory_guidance = ?,
           attention_mode = ?, attention_guidance = ?,
           disabled_capabilities = ?, rerun_on_restart = ?, once = ?,
           revision = revision + 1, edit_revision = edit_revision + 1,
           updated_at = ? where id = ?`,
      )
      .run(
        fields.ownerId,
        fields.agentId,
        fields.name,
        fields.instructions,
        fields.schedule,
        fields.tz,
        fields.deadlineMs,
        fields.retentionDays,
        fields.nextAt,
        fields.ownMemory ? 1 : 0,
        fields.memoryGuidance,
        fields.attentionMode,
        fields.attentionGuidance,
        JSON.stringify(fields.disabledCapabilities),
        fields.rerunOnRestart ? 1 : 0,
        fields.once ? 1 : 0,
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

  // a once task's fire spends it, after its event in the same
  // transaction: suspended by nobody, at the time it fired, naming the
  // run it started
  spendOnce(
    id: string,
    sessionId: string,
    now: number,
  ): AutomationSummary | null {
    this.db
      .query(
        `update automations set suspended_at = ?, suspended_by = null,
           once_fired_at = ?, once_run_session_id = ?, next_at = null,
           revision = revision + 1, updated_at = ?
         where id = ? and once = 1 and suspended_at is null`,
      )
      .run(now, now, sessionId, now, id);
    return this.byId(id);
  }

  // a restart's rerun of the once run is the once run from now on, so
  // the page links it and a second restart reruns it again
  carryOnceRun(
    id: string,
    sessionId: string,
    now: number,
  ): AutomationSummary | null {
    this.db
      .query(
        `update automations set once_run_session_id = ?,
           revision = revision + 1, updated_at = ?
         where id = ? and once_run_session_id is not null`,
      )
      .run(sessionId, now, id);
    return this.byId(id);
  }

  // a write the row did not make, such as a foreign key clearing a run
  // it named: the revision moves, so a client takes the row again
  touch(id: string): AutomationSummary | null {
    this.db
      .query("update automations set revision = revision + 1 where id = ?")
      .run(id);
    return this.byId(id);
  }

  forgetCapability(key: string, projectId?: string): void {
    forgetCapabilityIn(this.db, "automations", key, projectId);
  }

  // armed again: a task that ran once runs once more
  resume(id: string, nextAt: number, now: number): AutomationSummary | null {
    this.db
      .query(
        `update automations set suspended_at = null, suspended_by = null,
           next_at = ?, once_fired_at = null, once_run_session_id = null,
           revision = revision + 1, updated_at = ?
         where id = ? and suspended_at is not null`,
      )
      .run(nextAt, now, id);
    return this.byId(id);
  }

  recordEvent(id: string, fields: EventFields): AutomationSummary | null {
    const runSessionId = fields.runSessionId ?? null;
    this.db
      .query(
        `update automations set last_event_at = ?, last_event_due_at = ?,
           last_event_source = ?, last_event_outcome = ?,
           last_event_reason = ?, next_at = coalesce(?, next_at),
           last_run_session_id = coalesce(?, last_run_session_id),
           last_run_status = iif(? is null, last_run_status, 'running'),
           revision = revision + 1, updated_at = ? where id = ?`,
      )
      .run(
        fields.at,
        fields.dueAt,
        fields.source,
        fields.outcome,
        fields.reason,
        fields.nextAt ?? null,
        runSessionId,
        runSessionId,
        fields.at,
        id,
      );
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

  // the active automations on an agent, which its delete suspends
  activeOn(agentId: string): string[] {
    return this.db
      .query<{ id: string }, [string]>(
        `select id from automations
         where agent_id = ? and suspended_at is null order by created_at, id`,
      )
      .all(agentId)
      .map((row) => row.id);
  }

  // an agent's delete suspends its active automations as the admin and
  // moves every one's revision, since each summary now says the agent is
  // retired and a client keeps only a newer revision
  retireAgent(agentId: string, by: string, now: number): AutomationSummary[] {
    this.db
      .query(
        `update automations set
           suspended_by = iif(suspended_at is null, ?, suspended_by),
           updated_at = iif(suspended_at is null, ?, updated_at),
           suspended_at = coalesce(suspended_at, ?),
           next_at = null, revision = revision + 1
         where agent_id = ?`,
      )
      .run(by, now, now, agentId);
    return this.db
      .query<Raw, [string]>(
        `${SELECT} where automations.agent_id = ?
         order by automations.created_at, automations.id`,
      )
      .all(agentId)
      .map(row);
  }
}
