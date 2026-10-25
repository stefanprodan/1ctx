// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automations row as the store reads it, and its summary.

import type {
  AutomationSummary,
  CheckResult,
} from "../../shared/contracts/automation.ts";
import type {
  AttentionMode,
  EventOutcome,
  EventSource,
  SessionStatus,
} from "../../shared/words.ts";
import { alertColumns, alertOf, type RawAlert } from "../sessions/index.ts";

export type Raw = RawAlert & {
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
  check_url: string | null;
  last_checked_at: number | null;
  last_check_result: CheckResult | null;
  last_answered_at: number | null;
  disabled_capabilities: string;
  rerun_on_restart: number;
  post_to_channel: number;
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

// the row with the usernames of its owner and of whoever suspended it,
// and its agent's name, a retired one included
export const SELECT = `select automations.*, owners.username as owner_name,
    suspenders.username as suspended_by_name,
    agents.name as agent_name,
    agents.deleted_at is not null as agent_retired,
    ${alertColumns("automations")}
  from automations
  join users owners on owners.id = automations.owner_id
  join agents on agents.id = automations.agent_id
  left join users suspenders on suspenders.id = automations.suspended_by`;

export const row = (raw: Raw): AutomationSummary => ({
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
  checkUrl: raw.check_url,
  lastCheckedAt: raw.last_checked_at,
  lastCheckResult: raw.last_check_result,
  lastAnsweredAt: raw.last_answered_at,
  disabledCapabilities: JSON.parse(raw.disabled_capabilities),
  rerunOnRestart: raw.rerun_on_restart === 1,
  postToChannel: raw.post_to_channel === 1,
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
