// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The area's pure parts: the create spec from the caps, the keep-alive's
// pid, and which bus events recycle which session.

import { describe, expect, test } from "bun:test";
import type { BusEvent } from "../../../src/server/lib/bus.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { recyclesOf } from "../../../src/server/sandbox/events.ts";
import {
  createSpec,
  KEEP_ALIVE_COMMAND,
  keepAlivePid,
} from "../../../src/server/sandbox/index.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

const MiB = 1024 * 1024;

describe("the create spec", () => {
  test("sizes each synced root from its cap and binds repositories read-only", () => {
    const spec = createSpec({
      name: "1ctx-i-x",
      instanceId: "i",
      image: "img",
      caps: { ...DEFAULT_LIMITS, mcpKeptBytes: 32 * MiB },
      repos: [{ name: "app", tree: "/cache/t/files" }],
    });
    const size = (target: string) =>
      spec.mounts.find((mount) => mount.target === target);
    expect(size("/mcp")).toEqual({
      type: "tmpfs",
      target: "/mcp",
      sizeBytes: 40 * MiB,
      exec: false,
    });
    expect(size("/knowledge")).toMatchObject({ exec: false });
    expect(size("/uploads")).toMatchObject({ exec: false });
    // the container's own disk, never a tmpfs the memory limit counts
    for (const target of ["/tmp", "/opt/home", "/sandbox/tmp"])
      expect(size(target)).toBeUndefined();
    expect(spec.policy.readWrite).toEqual(
      expect.arrayContaining(["/tmp", "/sandbox/tmp"]),
    );
    expect(spec.policy.readWrite).toEqual(
      expect.arrayContaining(["/opt/home", "/dev/ptmx", "/dev/pts"]),
    );
    expect(spec.policy.readOnly).toContain("/sys/fs/cgroup");
    // the cwd records and up to eleven opened copies of a doc
    expect(size("/sandbox/.1ctx")).toMatchObject({
      sizeBytes: 4 * MiB + 11 * DEFAULT_LIMITS.knowledgeFileBytes,
    });
    expect(size("/repos/app")).toEqual({
      type: "bind",
      source: "/cache/t/files",
      target: "/repos/app",
    });
    expect(spec.mounts.some((mount) => mount.target === "/sandbox")).toBe(
      false,
    );
  });
});

describe("the keep-alive", () => {
  test("one pid other than 1, or none", () => {
    expect(keepAlivePid("42\n")).toBe(42);
    expect(keepAlivePid("")).toBeNull();
    expect(keepAlivePid("1\n")).toBeNull();
    expect(keepAlivePid("42\n43\n")).toBeNull();
    expect(keepAlivePid("4x\n")).toBeNull();
  });

  test("is found with bash builtins and no startup files", () => {
    expect(KEEP_ALIVE_COMMAND.slice(0, 4)).toEqual([
      "/usr/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
    ]);
    expect(KEEP_ALIVE_COMMAND[4]).toContain("mapfile -d ''");
    expect(KEEP_ALIVE_COMMAND[4]).toContain("'/usr/bin/sleep'");
  });
});

const session = (fields: Partial<SessionSummary>): SessionSummary =>
  ({
    id: "s1",
    projectId: "p",
    origin: "chat",
    forkedFromId: null,
    archived: null,
    ...fields,
  }) as SessionSummary;
const changed = (
  fields: Partial<SessionSummary>,
  extra: { cleared?: true; send?: { status: string } | null } = {},
): BusEvent =>
  ({
    type: "session.changed",
    data: {
      projectId: "p",
      session: session(fields),
      messages: [],
      send: extra.send ?? null,
      ...(extra.cleared ? { cleared: true } : {}),
    },
  }) as BusEvent;

describe("the bus events that recycle", () => {
  test("a clear, an archive, a delete, a run's and a child's end", () => {
    expect(recyclesOf(changed({}, { cleared: true }))).toEqual([
      { sessionId: "s1", reason: "clear" },
    ]);
    expect(
      recyclesOf(changed({ archived: { at: 1, reason: "idle" } })),
    ).toEqual([{ sessionId: "s1", reason: "archive" }]);
    expect(
      recyclesOf({
        type: "session.deleted",
        data: { projectId: "p", sessionId: "s1" },
      }),
    ).toEqual([{ sessionId: "s1", reason: "delete" }]);
    expect(
      recyclesOf(
        changed({ origin: "automation" }, { send: { status: "done" } }),
      ),
    ).toEqual([{ sessionId: "s1", reason: "run" }]);
    expect(
      recyclesOf(
        changed({ origin: "automation" }, { send: { status: "running" } }),
      ),
    ).toEqual([]);
    // a chat's turn ending keeps its sandbox
    expect(recyclesOf(changed({}, { send: { status: "done" } }))).toEqual([]);
    const child = (status: string) =>
      ({
        type: "child.changed",
        data: {
          projectId: "p",
          sessionId: "root",
          messageId: "m",
          child: { sessionId: "c1", status, tokens: 0, rows: [] },
        },
      }) as BusEvent;
    expect(recyclesOf(child("running"))).toEqual([]);
    expect(recyclesOf(child("failed"))).toEqual([
      { sessionId: "c1", reason: "child" },
    ]);
  });

  test("a fork leaves its source's sandbox alone", () => {
    expect(recyclesOf(changed({ id: "f1", forkedFromId: "s1" }))).toEqual([]);
  });
});
