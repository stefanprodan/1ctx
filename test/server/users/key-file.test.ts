// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// `1ctx admin-key`: a fresh key in an owner-only file, never over one,
// and never for a username a key file cannot spell.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAdminKey } from "../../../src/server/users/key-file.ts";
import { isAdminKey } from "../../../src/server/users/rules.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-admin-key-"));
  dirs.push(dir);
  return dir;
};

test("writes an owner-only file that holds an admin key", () => {
  const dir = join(scratch(), "secrets");
  const made = makeAdminKey("ops", dir);
  if (!made.ok) throw new Error(made.error);
  expect(made.path).toBe(join(dir, "user-ops.key"));
  expect(statSync(made.path!).mode & 0o777).toBe(0o600);
  const held = readFileSync(made.path!, "utf8").trim();
  expect(isAdminKey(held)).toBe(true);
  expect(held).toBe(made.key);
});

test("never writes over a file", () => {
  const dir = scratch();
  expect(makeAdminKey("ops", dir).ok).toBe(true);
  const before = readFileSync(join(dir, "user-ops.key"), "utf8");
  expect(makeAdminKey("ops", dir).ok).toBe(false);
  expect(readFileSync(join(dir, "user-ops.key"), "utf8")).toBe(before);
});

test.each(["has_underscore", "ab", "Upper"])("refuses %s", (username) => {
  expect(makeAdminKey(username, scratch())).toMatchObject({ ok: false });
});

test("prints a fresh key and writes no file", () => {
  const a = makeAdminKey("ops", null);
  const b = makeAdminKey("ops", null);
  if (!a.ok || !b.ok) throw new Error("no key");
  expect(a.path).toBeNull();
  expect(isAdminKey(a.key)).toBe(true);
  expect(a.key).not.toBe(b.key);
});
