// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fence that keeps a local run off every real engine: on the clone
// a run opens, every provider points at the fake model and every agent
// at its one model, every MCP server at the fake MCP, no key is named,
// web access is off (the `web` row's mode, which gates webfetch and
// websearch) and search has no provider, and the automations are
// suspended so a run's load never depends on the hour. A database
// holding repositories or credentials is refused, since a turn could
// reach their hosts.

import type { Database } from "bun:sqlite";
import { FAKE } from "./shapes.ts";

export type FenceOptions = {
  modelUrl: string;
  mcpUrl: (server: string) => string;
  // every user's password hash, so the run can sign them in
  passwordHash?: string;
  // the time written as the automations' suspension
  now?: number;
};

export type FenceReport = {
  providers: number;
  agents: number;
  servers: number;
  automations: number;
  users: number;
};

const OUTBOUND = ["repos", "credentials"];

export function fence(db: Database, o: FenceOptions): FenceReport {
  const has = (table: string) =>
    db
      .query<{ n: number }, [string]>(
        "select count(*) as n from sqlite_master where type = 'table' and name = ?",
      )
      .get(table)!.n > 0;
  for (const table of OUTBOUND) {
    if (!has(table)) continue;
    const n = db
      .query<{ n: number }, []>(`select count(*) as n from "${table}"`)
      .get()!.n;
    if (n > 0) {
      throw new Error(
        `the database has ${n} ${table} rows, which could reach real hosts: build one with make load-db`,
      );
    }
  }
  const report: FenceReport = {
    providers: 0,
    agents: 0,
    servers: 0,
    automations: 0,
    users: 0,
  };
  db.transaction(() => {
    report.providers = db
      .query("update providers set base_url = ?, key_name = null")
      .run(o.modelUrl).changes;
    report.agents = db
      .query("update agents set model = ?, model_name = ?")
      .run(FAKE.model, FAKE.model).changes;
    db.query("update deciders set model = ?").run(FAKE.model);
    if (has("tools")) {
      db.query(
        "update tools set enabled = 0, mode = 'off', provider = null where name in ('web', 'webfetch', 'websearch')",
      ).run();
    }
    const servers = db
      .query<{ id: string; name: string }, []>(
        "select id, name from mcp_servers",
      )
      .all();
    for (const s of servers) {
      db.query(
        "update mcp_servers set url = ?, key_name = null where id = ?",
      ).run(o.mcpUrl(s.name), s.id);
    }
    report.servers = servers.length;
    report.automations = db
      .query(
        "update automations set suspended_at = ?, next_at = null where suspended_at is null",
      )
      .run(o.now ?? Date.now()).changes;
    if (o.passwordHash !== undefined) {
      report.users = db
        .query("update users set password_hash = ?, must_change_password = 0")
        .run(o.passwordHash).changes;
    }
  })();
  return report;
}

// what the fence promised, read back: every provider and server on the
// fakes, every automation suspended, the web tools off
export function fenced(db: Database, o: FenceOptions): string[] {
  const wrong: string[] = [];
  for (const p of db
    .query<{ name: string; base_url: string }, []>(
      "select name, base_url from providers",
    )
    .all()) {
    if (p.base_url !== o.modelUrl) wrong.push(`provider ${p.name}`);
  }
  for (const s of db
    .query<{ name: string; url: string }, []>(
      "select name, url from mcp_servers",
    )
    .all()) {
    if (s.url !== o.mcpUrl(s.name)) wrong.push(`mcp server ${s.name}`);
  }
  const live = db
    .query<{ n: number }, []>(
      "select count(*) as n from automations where suspended_at is null",
    )
    .get()!.n;
  if (live > 0) wrong.push(`${live} automations not suspended`);
  const web = db
    .query<{ n: number }, []>(
      "select count(*) as n from tools where name in ('web', 'webfetch', 'websearch') and (mode <> 'off' or enabled = 1 or provider is not null)",
    )
    .get()!.n;
  if (web > 0) wrong.push(`web access or search on (${web} rows)`);
  return wrong;
}
