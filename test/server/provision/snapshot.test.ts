// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "../../../src/server/db/index.ts";
import { fileDb } from "../../helpers/db.ts";
import {
  changes,
  documents,
  network,
  object,
  recompose,
  snapshot,
} from "./helpers.ts";

test("preflight migrates a missing database only in memory", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-inspect-"));
  const path = join(dir, "new.sqlite");
  try {
    using db = inspect(path);
    expect(db.query("select count(*) as n from users").get()).toEqual({ n: 0 });
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight reads committed WAL rows without changing their source", () => {
  const file = fileDb();
  try {
    file.db.exec("create table inspection_probe (value text)");
    file.db.exec("insert into inspection_probe values ('before')");
    using copy = inspect(file.path);
    expect(copy.query("select value from inspection_probe").get()).toEqual({
      value: "before",
    });

    copy.exec("update inspection_probe set value = 'after'");
    expect(file.db.query("select value from inspection_probe").get()).toEqual({
      value: "before",
    });
  } finally {
    file.cleanup();
  }
});

test("offline web validation reads stored domains and mode from a database snapshot", async () => {
  const file = fileDb();
  const fake = network();
  const now = { value: 1_000_000 };
  const app = await recompose({ db: file.db, now }, fake.fetcher);
  try {
    await app.provision.apply(
      documents(
        object("Tool", "web", {
          mode: "listed",
          domains: ["docs.example.test"],
        }),
        object("Tool", "websearch", { provider: null }),
      ),
      () => {},
    );
    const before = snapshot(file.db);
    const count = changes(file.db);
    using copy = inspect(file.path);
    const check = await recompose({ db: copy, now }, fake.fetcher);
    try {
      const copyBefore = snapshot(copy);
      const copyCount = changes(copy);
      expect(() =>
        check.provision.validate(
          documents(object("Tool", "web", { mode: "listed" })),
        ),
      ).not.toThrow();
      expect(() =>
        check.provision.validate(
          documents(object("Tool", "web", { domains: [] })),
        ),
      ).toThrow("spec.domains list at least one host");
      expect(() =>
        check.provision.validate(
          documents(object("Tool", "web", { mode: "off", domains: [] })),
        ),
      ).not.toThrow();
      expect(snapshot(copy)).toEqual(copyBefore);
      expect(changes(copy)).toBe(copyCount);
      expect(snapshot(file.db)).toEqual(before);
      expect(changes(file.db)).toBe(count);
      expect(fake.calls).toEqual([]);
    } finally {
      await check.shutdown();
    }
  } finally {
    await app.shutdown();
    file.cleanup();
  }
});
