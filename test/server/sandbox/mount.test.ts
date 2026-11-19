// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox backend behind mount.ts with the real commit: what it
// read back lands in the rows, the sandbox is put back to what the rows
// store, and the next command pushes only what changed since.

import { describe, expect, test } from "bun:test";
import { wallClock } from "../../../src/server/lib/clock.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { sandboxBackend } from "../../../src/server/sandbox/backend.ts";
import { Leases } from "../../../src/server/sandbox/index.ts";
import { TREE_SLACK_BYTES } from "../../../src/server/sandbox/spec.ts";
import { fakeGateway } from "../../helpers/sandbox.ts";
import type { CommandEffect, FakeFs } from "../../helpers/sandbox-fs.ts";
import { callCaps, run, scratchState, setup } from "../bash/helpers.ts";

function sandboxed(plays: Record<string, (fs: FakeFs) => CommandEffect>) {
  const fake = fakeGateway();
  fake.onFiles = (_, fs) => {
    fs.onCommand = ({ command, fs: tree }) => plays[command]?.(tree) ?? {};
  };
  const limits = { ...DEFAULT_LIMITS };
  const leases = new Leases({
    clock: wallClock,
    log: silent,
    gateway: fake.connect({
      endpoint: "https://g.test:1",
      ca: "",
      cert: "",
      key: "",
    }),
    instanceId: "a1b2c3d4e5f6",
    image: "img",
    limits: () => limits,
    repos: { hold: () => () => {} },
  });
  const backend = sandboxBackend({
    clock: wallClock,
    log: silent,
    limits: () => limits,
  });
  const s = setup({}, undefined, undefined, () => ({
    acquire: (call, deadline, signal) => leases.acquire(call, deadline, signal),
    run: backend.run,
  }));
  const files = () => [...fake.files.values()][0]!;
  return { s, fake, leases, backend, files, limits };
}

describe("the sandbox behind the mount", () => {
  test("a command's changes commit, and the sandbox holds what the rows store", async () => {
    const t = sandboxed({
      edit: (fs) => {
        fs.write("/knowledge/a.md", "﻿new\n");
        fs.write("/tmp/s.txt", "s");
        return { stdout: "done\n", pwd: "/tmp" };
      },
    });
    try {
      t.s.knowledge.create(t.s.projectId, t.s.author, "a.md", "old\n");
      const result = await run(t.s, "edit", callCaps);
      expect(result.error).toBe(false);
      expect(result.content).toContain("done");
      await t.backend.idle();
      const scratch = scratchState(t.s);
      expect(scratch.cwd).toBe("/tmp");
      expect(scratch.entries.map((file) => file.path)).toEqual(["s.txt"]);
      const doc = t.s.knowledge.store.mounted(t.s.projectId)[0]!;
      expect(new TextDecoder().decode(doc.data)).toBe("new\n");
      const tree = t.files().tree();
      // the stored text, BOM dropped, at the doc's time; scratch at used_at
      expect(tree["/knowledge/a.md"]).toBe(`644 ${doc.updatedAt} new\n`);
      expect(tree["/tmp/s.txt"]).toBe(`644 ${scratch.usedAt} s`);
      const calls = t.files().calls.length;
      const again = await run(t.s, "noop", callCaps);
      expect(again.error).toBe(false);
      await t.backend.idle();
      // the clock stood still, so no stored time moved: nothing to push
      // before the command or after it
      expect(t.files().calls.slice(calls)).toEqual([
        "command",
        "fence",
        "walk",
        "pull",
        "records",
      ]);
      t.s.now.value += 1000;
      await run(t.s, "noop", callCaps);
      await t.backend.idle();
      // scratch's new used_at, one frame a file and folder
      expect(t.files().calls.at(-1)).toBe("push");
      expect(t.files().tree()["/tmp/s.txt"]).toBe(
        `644 ${scratchState(t.s).usedAt} s`,
      );
    } finally {
      t.leases.close();
      t.s.db.close();
    }
  });

  test("a change to /uploads is discarded with its notice and the sandbox goes", async () => {
    const t = sandboxed({
      touch: (fs) => {
        fs.write("/uploads/x", "x");
        fs.write("/tmp/kept.txt", "y");
        return {};
      },
    });
    try {
      const result = await run(t.s, "touch", callCaps);
      expect(result.content).toContain("changes under /uploads were discarded");
      expect(scratchState(t.s).entries.map((file) => file.path)).toEqual([
        "kept.txt",
      ]);
      await t.backend.idle();
      expect(t.fake.deletes).toHaveLength(1);
    } finally {
      t.leases.close();
      t.s.db.close();
    }
  });

  test("a key echoed across the result's cut leaves no part of it", async () => {
    const key = "made-up-key-0123456789abcdef";
    const credential = {
      name: "quotes",
      prefix: "https://api.example.test/v1/",
      key,
      header: "Authorization",
      template: "Bearer {key}",
      value: `Bearer ${key}`,
      methods: ["GET" as const],
    };
    // a 1000 cut keeps 931 characters of output beside its mark and exit,
    // so a cut first would keep the key's first 10 and the scrub after it
    // would match nothing
    const filler = "x".repeat(callCaps.resultCut - 79);
    const t = sandboxed({
      echo: () => ({ stdout: `${filler}${key}${"y".repeat(500)}\n` }),
    });
    try {
      const result = await run(t.s, "echo", {
        ...callCaps,
        web: { mode: "listed", domains: ["api.example.test"] },
        fetchDeadlineMs: 1000,
        fetchBodyBytes: 1000,
        credentials: [credential],
      });
      expect(result.content).toContain("output cut at");
      for (let n = 6; n <= key.length; n++)
        expect(result.content).not.toContain(key.slice(0, n));
      await t.backend.idle();
    } finally {
      t.leases.close();
      t.s.db.close();
    }
  });

  test("a tree over a lowered cap is made as large as the rows hold", async () => {
    const t = sandboxed({});
    try {
      const text = "x".repeat(4000);
      t.s.knowledge.create(t.s.projectId, t.s.author, "a.md", text);
      t.limits.knowledgeProjectBytes = 1000;
      const result = await run(t.s, "noop", callCaps);
      expect(result.error).toBe(false);
      await t.backend.idle();
      const knowledge = t.fake.creates[0]!.mounts.find(
        (mount) => mount.target === "/knowledge",
      );
      expect(knowledge).toMatchObject({ sizeBytes: 4000 + TREE_SLACK_BYTES });
    } finally {
      t.leases.close();
      t.s.db.close();
    }
  });
});
