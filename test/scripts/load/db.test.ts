// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../../scripts/load/db/build.ts";
import { fence, fenced } from "../../../scripts/load/fence.ts";
import { fakeMcpUrl, fakeModelUrl } from "../../../scripts/load/shapes.ts";

const dir = mkdtempSync(join(tmpdir(), "load-db-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const quiet = () => {};
const sha = async (path: string) =>
  new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");

const options = {
  modelUrl: fakeModelUrl(),
  mcpUrl: (s: string) => fakeMcpUrl(s),
  passwordHash: "a-hash",
};

describe("the database builder", () => {
  test.serial(
    "a tiny build migrates, opens and reads as the app reads it",
    async () => {
      const out = join(dir, "a.sqlite");
      const summary = await build({ preset: "tiny", out, log: quiet });
      const validation = summary.validation as Record<string, unknown>;
      expect(validation.failures).toEqual([]);
      expect(validation.migrateRan).toEqual([]);
      const db = new Database(out);
      const providers = db
        .query<{ name: string; base_url: string }, []>(
          "select name, base_url from providers",
        )
        .all();
      // the builder makes no provider but the fake
      expect(providers).toEqual([{ name: "fake", base_url: fakeModelUrl() }]);
      const servers = db
        .query<{ n: number }, []>("select count(*) as n from mcp_tools")
        .get()!;
      expect(servers.n).toBe(93);
      db.close();
    },
  );

  test.serial("two builds of one preset are one file", async () => {
    await build({ preset: "tiny", out: join(dir, "b.sqlite"), log: quiet });
    expect(await sha(join(dir, "b.sqlite"))).toBe(
      await sha(join(dir, "a.sqlite")),
    );
  });

  test.serial(
    "the fence moves every provider and server onto the fakes",
    () => {
      const db = new Database(join(dir, "a.sqlite"));
      db.query(
        "insert into providers (id, name, wire, base_url, key_name, created_at) values ('p2', 'elsewhere', 'openai-compatible', 'http://models.test/v1', 'provider-elsewhere', 0)",
      ).run();
      db.query("update mcp_servers set url = 'https://mcp.test/mcp'").run();
      expect(fenced(db, options).length).toBeGreaterThan(0);
      const report = fence(db, options);
      expect(report.providers).toBe(2);
      expect(report.servers).toBe(3);
      expect(fenced(db, options)).toEqual([]);
      const keys = db
        .query<{ n: number }, []>(
          "select count(*) as n from providers where key_name is not null",
        )
        .get()!;
      expect(keys.n).toBe(0);
      const hashes = db
        .query<{ h: string }, []>(
          "select distinct password_hash as h from users",
        )
        .all();
      expect(hashes).toEqual([{ h: "a-hash" }]);
      db.close();
    },
  );

  test.serial("the fence refuses a database with credentials", () => {
    const db = new Database(join(dir, "b.sqlite"));
    const cols = db
      .query<{ name: string; notnull: number; dflt_value: string | null }, []>(
        "select name, \"notnull\", dflt_value from pragma_table_info('credentials')",
      )
      .all();
    // a row with every required column filled with its name
    const required = cols.filter(
      (c) => c.notnull === 1 && c.dflt_value === null,
    );
    db.query(
      `insert into credentials (${required.map((c) => c.name).join(", ")}) values (${required.map(() => "?").join(", ")})`,
    ).run(...required.map((c) => (c.name.endsWith("_at") ? 0 : c.name)));
    expect(() => fence(db, options)).toThrow("credentials");
    db.close();
  });
});
