// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/index.ts";
import { MIGRATIONS } from "../../../src/server/db/migrations/index.ts";

describe("0018 web access", () => {
  test.each([
    { fetch: 0, search: 0, mode: "off", provider: null },
    { fetch: 0, search: 1, mode: "all", provider: "tavily" },
    { fetch: 1, search: 0, mode: "all", provider: null },
    { fetch: 1, search: 1, mode: "all", provider: "tavily" },
  ])(
    "fetch $fetch and search $search become $mode",
    ({ fetch, search, mode, provider }) => {
      const db = new Database(":memory:");
      try {
        db.exec("pragma foreign_keys = on");
        migrate(db, MIGRATIONS.slice(0, 17));
        db.query(
          "update tools set enabled = ?, updated_at = 5 where name = 'webfetch'",
        ).run(fetch);
        db.query(
          "update tools set enabled = ?, provider = 'tavily', updated_at = 6 where name = 'websearch'",
        ).run(search);
        db.exec(`
          update tools set enabled = 0, hosts = '["https://assets.example.test"]',
            updated_at = 7 where name = 'visualize';
        `);
        const before = db
          .query<Record<string, unknown>, []>(
            "select * from tools order by rowid",
          )
          .all();
        expect(migrate(db)).toEqual(["0018-web-access"]);
        expect(MIGRATIONS[17]?.rebuild).toBeUndefined();
        const after = db.query("select * from tools order by rowid").all();
        expect(after.slice(0, 3)).toEqual(
          before.map((row) => ({
            ...row,
            provider: row.name === "websearch" ? provider : row.provider,
            mode: "all",
          })),
        );
        expect(after[3]).toEqual({
          name: "web",
          mode,
          enabled: 1,
          provider: null,
          hosts: "[]",
          updated_at: 6,
        });
        expect(db.query("pragma foreign_keys").get()).toEqual({
          foreign_keys: 1,
        });
        expect(db.query("pragma foreign_key_check").all()).toEqual([]);
        expect(migrate(db)).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  test("fresh access is all with no search provider and bounded modes", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      expect(
        db.query("select mode, hosts from tools where name = 'web'").get(),
      ).toEqual({ mode: "all", hosts: "[]" });
      expect(
        db.query("select provider from tools where name = 'websearch'").get(),
      ).toEqual({ provider: null });
      for (const mode of ["off", "all", "listed"]) {
        db.query("update tools set mode = ? where name = 'web'").run(mode);
      }
      expect(() =>
        db.query("update tools set mode = 'other' where name = 'web'").run(),
      ).toThrow();
      expect(() =>
        db.query("update tools set mode = null where name = 'web'").run(),
      ).toThrow();
      for (const table of ["sessions", "automations"]) {
        expect(db.query(`pragma table_info(${table})`).all()).toContainEqual(
          expect.objectContaining({
            name: "disabled_capabilities",
            type: "TEXT",
            notnull: 1,
            dflt_value: "'[]'",
          }),
        );
      }
    } finally {
      db.close();
    }
  });
});
