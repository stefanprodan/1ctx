// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The run caps become caps on every chat and run. Each old override sat
// beside a constant chat cap, 4 per user and 32 in the process, so the
// new one adds it, held to the new bounds and to per user <= per
// project <= in the process. The numbers are frozen here: a migration
// never reads the code's defaults, which may move.
const PER_USER = { default: 4, min: 1, max: 16 };
const PER_PROJECT_DEFAULT = 16;
const RUNNING = { default: 64, min: 4, max: 256 };

type Row = { name: string; value: number; updated_at: number };

const clamp = (value: number, bounds: { min: number; max: number }) =>
  Math.max(bounds.min, Math.min(bounds.max, value));

export const m0034: Migration = {
  id: "0034-send-limits",
  up(db) {
    const rows = db
      .query<Row, []>("select name, value, updated_at from limits")
      .all();
    const of = (name: string) => rows.find((row) => row.name === name);
    const perProject = of("sendsPerProject")?.value ?? PER_PROJECT_DEFAULT;
    const put = (name: string, value: number, def: number, at: number) => {
      if (value === def) return;
      db.query(
        "insert into limits (name, value, updated_at) values (?, ?, ?)",
      ).run(name, value, at);
    };
    const perUser = of("runsPerUser");
    if (perUser !== undefined) {
      const value = Math.min(clamp(perUser.value + 4, PER_USER), perProject);
      put("sendsPerUser", value, PER_USER.default, perUser.updated_at);
    }
    const running = of("runsRunning");
    if (running !== undefined) {
      const value = Math.max(clamp(running.value + 32, RUNNING), perProject);
      put("sendsRunning", value, RUNNING.default, running.updated_at);
    }
    db.exec("delete from limits where name in ('runsPerUser', 'runsRunning')");
  },
};
