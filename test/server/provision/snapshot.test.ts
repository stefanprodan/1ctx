// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "../../../src/server/db/index.ts";
import { fileDb } from "../../helpers/db.ts";

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
