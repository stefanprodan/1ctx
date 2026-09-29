// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the server takes from a command worker: an answer of this job
// passes only whole, names and paths by the knowledge name rule, and
// one that does not check out is malformed rather than dropped.

import { describe, expect, test } from "bun:test";
import {
  fromWorker,
  MALFORMED,
} from "../../../src/server/knowledge/protocol.ts";

const changes = {
  knowledge: [{ name: "docs/a.md", text: "a\n" }],
  written: [{ path: "out.bin", data: new Uint8Array([1]), mode: 0o644 }],
  removed: ["old.txt"],
  cwd: "/knowledge",
};
const done = (patch: Record<string, unknown> = {}) => ({
  type: "done",
  id: "job",
  answer: {
    stdout: "",
    stderr: "",
    exitCode: 0,
    notice: "",
    opened: [],
    changes: { ...changes, ...patch },
  },
});

describe("a command worker's messages", () => {
  test("a whole answer of this job passes", () => {
    expect(fromWorker(done(), "job")).toEqual(done() as never);
  });

  test("another id or an unknown type is dropped", () => {
    expect(fromWorker({ ...done(), id: "other" }, "job")).toBeNull();
    expect(fromWorker({ type: "shout", id: "job" }, "job")).toBeNull();
  });

  test.each([
    [
      "a doc outside the name rule",
      { knowledge: [{ name: "../x", text: "" }] },
    ],
    [
      "a scratch path outside the name rule",
      { written: [{ path: "a//b", data: new Uint8Array(), mode: 0o644 }] },
    ],
    ["a removed path outside the name rule", { removed: ["/etc/passwd"] }],
    ["totals the server counts itself", { totals: { files: 0, bytes: 0 } }],
  ])("%s makes the answer malformed", (_, patch) => {
    expect(fromWorker(done(patch), "job")).toBe(MALFORMED);
  });

  test("an opened file of an unknown kind makes the answer malformed", () => {
    const answer = done();
    const opened = {
      path: "/tmp/a",
      kind: "page",
      language: null,
      bytes: 1,
      lines: 1,
      title: null,
      text: "a",
    };
    expect(
      fromWorker(
        { ...answer, answer: { ...answer.answer, opened: [opened] } },
        "job",
      ),
    ).toBe(MALFORMED);
  });
});
