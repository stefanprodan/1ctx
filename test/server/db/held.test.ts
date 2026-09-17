// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heldByAnother, open } from "../../../src/server/db/index.ts";

function temp(name: string): string {
  return join(tmpdir(), `1ctx-held-${name}-${Bun.randomUUIDv7()}.sqlite`);
}

describe("heldByAnother", () => {
  test("an in-memory database is never held", () => {
    expect(heldByAnother(":memory:")).toBeFalse();
  });

  test("a path with no file yet is not held", () => {
    expect(heldByAnother(temp("absent"))).toBeFalse();
  });

  test("a closed database is not held", () => {
    const path = temp("closed");
    try {
      open(path).close();
      expect(heldByAnother(path)).toBeFalse();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  test("a database another connection holds open is held", () => {
    const path = temp("open");
    const held = open(path);
    try {
      expect(heldByAnother(path)).toBeTrue();
    } finally {
      held.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  test("the check leaves the database usable and unlocked", () => {
    const path = temp("after");
    try {
      open(path).close();
      expect(heldByAnother(path)).toBeFalse();
      const db = new Database(path, { strict: true });
      try {
        db.exec("begin immediate");
        db.exec("commit");
      } finally {
        db.close();
      }
      expect(heldByAnother(path)).toBeFalse();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});
