// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { AutomationStore } from "../../../src/server/automations/store.ts";
import { memoryDb } from "../../helpers/db.ts";

function seeded() {
  const db = memoryDb();
  db.query(
    "insert into users (id, username, full_name, email, role, password_hash, created_at) values ('u', 'user', 'User', 'user@example.com', 'member', 'x', 0)",
  ).run();
  db.query(
    "insert into projects (id, kind, name, owner_id, created_at) values ('p', 'personal', 'personal', 'u', 0)",
  ).run();
  db.query(
    "insert into providers (id, name, wire, base_url, created_at) values ('pr', 'prov', 'openai-compatible', 'http://x', 0)",
  ).run();
  db.query(
    "insert into agents (id, name, provider_id, model, model_name, created_at) values ('a', 'agent', 'pr', 'm', 'M', 0)",
  ).run();
  db.query(
    `insert into automations (id, project_id, owner_id, agent_id, name,
       instructions, schedule, tz, retention_days, next_at, created_at,
       updated_at)
     values ('au', 'p', 'u', 'a', 'digest', 'go', '0 * * * *', 'UTC', 30, 100, 0, 0)`,
  ).run();
  db.query(
    `insert into sessions (id, project_id, owner_id, agent_id, origin,
       automation_id, title, status, revision, created_at, last_activity_at,
       disabled_capabilities)
     values ('s0', 'p', 'u', 'a', 'automation', 'au', 'old', 'done', 0, 0, 0, '[]'),
       ('s1', 'p', 'u', 'a', 'automation', 'au', 'new', 'running', 0, 0, 0, '[]')`,
  ).run();
  db.query(
    "update automations set last_run_session_id = 's0', last_run_status = 'done' where id = 'au'",
  ).run();
  return { db, store: new AutomationStore(db) };
}

const columns = `next_at, last_run_session_id, last_run_status, last_event_at,
  last_event_due_at, last_event_source, last_event_outcome, last_event_reason,
  revision, updated_at`;

describe("recordEvent", () => {
  const base = {
    at: 500,
    dueAt: 100,
    source: "schedule" as const,
    outcome: "skipped" as const,
    reason: "why",
  };
  const event = {
    last_event_at: 500,
    last_event_due_at: 100,
    last_event_source: "schedule",
    last_event_outcome: "skipped",
    last_event_reason: "why",
    revision: 1,
    updated_at: 500,
  };
  const cases: [
    string,
    { nextAt?: number; runSessionId?: string },
    Record<string, unknown>,
  ][] = [
    [
      "the event alone",
      {},
      { next_at: 100, last_run_session_id: "s0", last_run_status: "done" },
    ],
    [
      "the event and the next fire",
      { nextAt: 900 },
      { next_at: 900, last_run_session_id: "s0", last_run_status: "done" },
    ],
    [
      "the event and the run",
      { runSessionId: "s1" },
      { next_at: 100, last_run_session_id: "s1", last_run_status: "running" },
    ],
    [
      "the event, the next fire and the run",
      { nextAt: 900, runSessionId: "s1" },
      { next_at: 900, last_run_session_id: "s1", last_run_status: "running" },
    ],
  ];
  for (const [name, fields, want] of cases) {
    test(`write ${name}`, () => {
      const { db, store } = seeded();
      expect(store.recordEvent("au", { ...base, ...fields })).not.toBeNull();
      expect(
        db.query(`select ${columns} from automations where id = 'au'`).get(),
      ).toEqual({ ...event, ...want });
    });
  }
});
