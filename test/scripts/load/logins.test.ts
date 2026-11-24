// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The load harness's minted logins against the real sign-in: a token
// the driver sends as its cookie is a login like any other.

import { describe, expect, test } from "bun:test";
import {
  mintLogins,
  newLogins,
  unminted,
} from "../../../scripts/load/logins.ts";
import type { MeResponse } from "../../../src/shared/api/access.ts";
import { testApp } from "../../helpers/app.ts";

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
