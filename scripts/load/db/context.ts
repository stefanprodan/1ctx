// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What one build shares across its steps: the database and its insert
// statements, the people and objects made so far, the row counts, and
// the id counter.

import type { Database } from "bun:sqlite";
import type { Clock, Preset } from "./presets.ts";

export function statements(db: Database) {
  const q = (sql: string) => db.prepare(sql);
  return {
    user: q(
      `insert into users (id, username, full_name, email, about, role, password_hash, disabled, must_change_password, created_at, tz, agent_id) values (?, ?, ?, ?, '', ?, ?, 0, 0, ?, ?, ?)`,
    ),
    provider: q(
      `insert into providers (id, name, wire, base_url, key_name, created_at) values (?, ?, ?, ?, ?, ?)`,
    ),
    agent: q(
      `insert into agents (id, name, avatar, provider_id, model, model_name, context_length, prompt_price, completion_price, tools, reasoning, prompt, thinking, effort, created_at, mcp_mode, model_described, thinking_required, reasoning_known, upstream, is_default, deleted_at) values (?, ?, 'bot', ?, ?, ?, 262144, 0.3, 1.2, 1, 1, ?, 'on', null, ?, 'auto', 1, 0, 1, null, ?, ?)`,
    ),
    project: q(
      `insert into projects (id, kind, name, description, owner_id, created_at) values (?, ?, ?, ?, ?, ?)`,
    ),
    member: q(
      `insert into memberships (project_id, user_id, created_at) values (?, ?, ?)`,
    ),
    automation: q(
      `insert into automations (id, project_id, owner_id, agent_id, name, instructions, schedule, tz, deadline_ms, retention_days, suspended_at, next_at, last_event_at, last_event_due_at, last_event_source, last_event_outcome, last_event_reason, last_run_session_id, last_run_status, revision, created_at, updated_at, suspended_by, own_memory, memory_guidance, disabled_capabilities) values (?, ?, ?, ?, ?, ?, ?, 'UTC', null, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?, '', '[]')`,
    ),
    session: q(
      `insert into sessions (id, project_id, owner_id, agent_id, origin, automation_id, title, status, revision, created_at, last_activity_at, run_source, forked_from_session_id, forked_from_message_id, disabled_capabilities, mcp_folders, archived_at, archived_by, archived_reason, attention, attention_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, '[]', ?, ?, ?, ?, ?, ?)`,
    ),
    send: q(
      `insert into sends (id, session_id, kind, user_id, agent_id, provider_id, provider_name, model, status, cause, error, first_message_id, rounds, tool_calls, started_at, finished_at, mcp, memory_round, memory_error, memory_skipped) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null)`,
    ),
    message: q(
      `insert into messages (id, session_id, seq, kind, send_id, round, slot, user_id, agent_id, content, reasoning, html, status, error, finish_reason, reasoning_details, tool_calls, tool_call_id, tool_name, model, ttft_ms, thinking_ms, created_at, finished_at, uploads, upstream, served_model, native_finish, packed, packed_bytes) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, ?, ?)`,
    ),
    usage: q(
      `insert into usage (id, send_id, session_id, project_id, user_id, agent_id, provider_id, model, round, seq, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cost, context_length, created_at, upstream, served_model) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 262144, ?, null, null)`,
    ),
    decision: q(
      `insert into decision_usage (id, decider_id, decider_name, provider_id, provider_name, model, purpose, session_id, project_id, input_tokens, output_tokens, cost, duration, created_at) values (?, ?, 'fake-decider', ?, 'fake', 'fake-decider', 'run-attention', ?, ?, ?, 0, ?, ?, ?)`,
    ),
    kept: q(
      `insert into mcp_kept_files (message_id, position, session_id, folder, dir, name, bytes, text, data) values (?, 0, ?, ?, ?, 'result.txt', ?, ?, null)`,
    ),
    scratch: q(
      `insert into session_scratch (session_id, cwd, revision, bytes, files, used_at) values (?, '/tmp', ?, ?, ?, ?)`,
    ),
    scratchFile: q(
      `insert into session_scratch_files (session_id, path, data, mode) values (?, ?, ?, 420)`,
    ),
    view: q(
      `insert into memory_views (session_id, snapshot, seen) values (?, ?, ?)`,
    ),
    note: q(
      `insert into memory_notes (project_id, automation_id, entries, previous_entries, revision, updated_at, updated_by, session_id, agent_name) values (?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
    ),
    visit: q(`insert into visits (user_id, day, at) values (?, ?, ?)`),
    knowledge: q(
      `insert into knowledge_files (id, project_id, name, kind, text, bytes, lines, digest, tokens, revision, author_kind, author_id, author_name, session_id, origin, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    version: q(
      `insert into knowledge_versions (id, file_id, project_id, name, revision, text, bytes, lines, author_kind, author_id, author_name, session_id, origin, written_at, deleted, file_snapshot) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, null)`,
    ),
  };
}

export type Statements = ReturnType<typeof statements>;

export type User = {
  id: string;
  name: string;
  admin: boolean;
  teams: number[];
  personal: string;
  // the agent the user picked, an index into the live agents
  pick: number | null;
};

export type Provider = { id: string; name: string; wire: string; url: string };

export type Agent = {
  id: string;
  name: string;
  provider: Provider;
  model: string;
  retiredAt: number | null;
  sre: boolean;
};

export type Team = { id: string; name: string; members: User[] };

export type Automation = {
  // null once deleted
  id: string | null;
  index: number;
  team: number;
  owner: User;
  agent: Agent;
  name: string;
  instructions: string;
  offset: number;
  ownMemory: boolean;
  running: boolean;
  // fires stop at: suspended, or deleted
  stopAt: number | null;
  keepOrphans: boolean;
  suspendedBy: User | null;
  lastRun: { id: string; status: string; at: number } | null;
  lastFire: number | null;
};

export type Build = {
  db: Database;
  q: Statements;
  preset: Preset;
  clock: Clock;
  newId: () => string;
  count: Record<string, number>;
  bump(key: string, n?: number): void;
  provider: Provider;
  decider: string;
  users: User[];
  agents: Agent[];
  liveAgents: Agent[];
  teams: Team[];
  automations: Automation[];
  log: (line: string) => void;
};
