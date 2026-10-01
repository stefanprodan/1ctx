// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the server takes from a command worker: an answer of this job
// passes only whole, docs by the knowledge name rule, scratch paths by
// the scratch rule, and one that does not check out is malformed rather
// than dropped.

import { describe, expect, test } from "bun:test";
import { fromWorker, MALFORMED } from "../../../src/server/bash/protocol.ts";

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
    refused: null,
  },
});

describe("a command worker's messages", () => {
  test("fetch bodies accept text and byte views, never other cloneable values", () => {
    const message = (body: unknown) => ({
      type: "fetch",
      id: "job",
      request: 0,
      url: "https://network.example.test/",
      options: { body },
    });
    for (const body of [
      "text",
      undefined,
      new Uint8Array([0, 255]),
      new Uint8Array([7, 0, 255, 8]).subarray(1, 3),
    ]) {
      const cloned = structuredClone(message(body));
      expect(fromWorker(cloned, "job") === cloned).toBe(true);
    }
    for (const body of [
      null,
      1,
      [0, 255],
      new ArrayBuffer(2),
      new Uint16Array([255]),
      new Uint8Array(new SharedArrayBuffer(2)),
      { 0: 255, length: 1 },
    ]) {
      expect(fromWorker(message(body), "job")).toBeNull();
    }
  });

  test("a whole answer of this job passes", () => {
    expect(fromWorker(done(), "job")).toEqual(done() as never);
  });

  test("scratch paths any real /tmp takes pass", () => {
    const patch = {
      written: [
        { path: "my notes.txt", data: new Uint8Array(), mode: 0o644 },
        { path: "Notes/-rf", data: new Uint8Array(), mode: 0o644 },
      ],
      removed: ["it's café.md"],
    };
    expect(fromWorker(done(patch), "job")).toEqual(done(patch) as never);
  });

  test("a refusal passes only as a string or null", () => {
    const refused = (value: unknown) => {
      const message = done();
      return { ...message, answer: { ...message.answer, refused: value } };
    };
    expect(fromWorker(refused("why"), "job")).toEqual(refused("why") as never);
    for (const value of [5, undefined, {}, ["why"]])
      expect(fromWorker(refused(value), "job")).toBe(MALFORMED);
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
    [
      "a scratch path climbing out",
      { written: [{ path: "../x", data: new Uint8Array(), mode: 0o644 }] },
    ],
    ["a removed path with a NUL", { removed: ["a\u0000b"] }],
    ["a spaced doc name", { knowledge: [{ name: "my notes.md", text: "" }] }],
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
