// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The load harness's minted logins against the real sign-in: a token
// the driver sends as its cookie is a login like any other.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { fence, fenced, migrateWith } from "../../../scripts/load/fence.ts";
import {
  mintLogins,
  newLogins,
  unminted,
} from "../../../scripts/load/logins.ts";
import { migrate } from "../../../src/server/db/index.ts";
import { MIGRATIONS } from "../../../src/server/db/migrations/index.ts";
import type { MeResponse } from "../../../src/shared/api/access.ts";
import { testApp } from "../../helpers/app.ts";
import { tempDirs } from "../../helpers/temp.ts";

const temp = tempDirs();
const ROOT = resolve(import.meta.dir, "../../..");

describe("a minted login", () => {
  test("signs its user in by cookie and ends the one before", async () => {
    const app = await testApp();
    try {
      const first = newLogins(["admin"]);
      expect(mintLogins(app.db, first.hashes, app.now.value)).toBe(1);
      const second = newLogins(["admin"]);
      mintLogins(app.db, second.hashes, app.now.value);
      expect(unminted(app.db, second.hashes, app.now.value)).toEqual([]);
      expect(unminted(app.db, first.hashes, app.now.value)).toEqual(["admin"]);
      const me = async (token: string) => {
        const client = app.client();
        client.cookie = `login=${token}`;
        const res = await client.call("GET", "/api/me");
        return ((await res.json()) as MeResponse).user?.username ?? null;
      };
      expect(await me(second.tokens.admin!)).toBe("admin");
      expect(await me(first.tokens.admin!)).toBeNull();
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });

  test("names only an enabled user", async () => {
    const app = await testApp();
    try {
      expect(() =>
        mintLogins(app.db, newLogins(["nobody"]).hashes, app.now.value),
      ).toThrow("no enabled user nobody");
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });

  test("keeps only hashes in the database", () => {
    const { tokens, hashes } = newLogins(["a", "b"]);
    expect(Object.keys(hashes)).toEqual(["a", "b"]);
    expect(hashes.a).not.toBe(tokens.a);
    expect(hashes.a).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.a).not.toBe(tokens.b);
  });
});

describe("a bench clone", () => {
  test("is migrated by the serving checkout before its logins are minted", () => {
    const path = join(temp("load-clone-"), "clone.sqlite");
    const old = new Database(path);
    // a clone one migration behind, as a database built from main is
    migrate(old, MIGRATIONS.slice(0, -1));
    old.close();
    const last = MIGRATIONS.at(-1)!.id;
    expect(migrateWith(ROOT, path)).toEqual([last]);
    const db = new Database(path);
    try {
      db.query(
        "insert into users (id, username, full_name, email, about, role, disabled, created_at, tz) values ('u1', 'ann', 'Ann', 'ann@load.example', '', 'member', 0, 0, 'UTC')",
      ).run();
      const options = {
        modelUrl: "http://127.0.0.1:1241/v1",
        mcpUrl: (s: string) => `http://127.0.0.1:1250/${s}/mcp`,
        logins: newLogins(["ann"]).hashes,
        now: Date.now(),
      };
      fence(db, options);
      expect(fenced(db, options)).toEqual([]);
    } finally {
      db.close();
    }
    // nothing left for the server to run at its start
    expect(migrateWith(ROOT, path)).toEqual([]);
  });
});
