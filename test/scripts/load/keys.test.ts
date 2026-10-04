// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreKeys } from "../../../scripts/load/cluster.ts";

// a kubectl that answers \`get secret\` with a canned result
const kubectl =
  (stdout: string, exit = 0, stderr = "") =>
  (..._args: string[]) => [
    "sh",
    "-c",
    `printf '%s' "$0"; printf '%s' "$1" >&2; exit ${exit}`,
    stdout,
    stderr,
  ];

describe("the namespace's keys", () => {
  test("replace the local ones, so the server keeps its users", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-keys-"));
    writeFileSync(join(dir, "user-admin.key"), "fresh-local");
    const secret = JSON.stringify({
      data: {
        "user-admin.key": Buffer.from("from-namespace").toString("base64"),
        "user-u001.key": Buffer.from("u001-pass").toString("base64"),
      },
    });
    expect(restoreKeys(kubectl(secret), dir)).toBe(2);
    expect(readFileSync(join(dir, "user-admin.key"), "utf8")).toBe(
      "from-namespace",
    );
    expect(readFileSync(join(dir, "user-u001.key"), "utf8")).toBe("u001-pass");
  });

  test("a fresh namespace has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-keys-"));
    const k = kubectl(
      "",
      1,
      'Error from server (NotFound): secrets "onectx" not found',
    );
    expect(restoreKeys(k, dir)).toBe(0);
  });

  test("any other failure stops the install", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-keys-"));
    const k = kubectl("", 1, "Unable to connect to the server");
    expect(() => restoreKeys(k, dir)).toThrow("Unable to connect");
  });
});
