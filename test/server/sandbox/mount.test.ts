// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox backend behind mount.ts with the real commit: what it
// read back lands in the rows, the sandbox is put back to what the rows
// store, the next command pushes only what changed since, and /tmp is
// the sandbox's own, so no scratch row is read, written or deleted.

import { describe, expect, test } from "bun:test";
import { PROCESS_SLOTS } from "../../../src/server/knowledge/limits.ts";
import { wallClock } from "../../../src/server/lib/clock.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { sandboxBackend } from "../../../src/server/sandbox/backend.ts";
import { HELPER_SOURCES } from "../../../src/server/sandbox/helpers.ts";
import { Leases } from "../../../src/server/sandbox/index.ts";
import { TREE_SLACK_BYTES } from "../../../src/server/sandbox/spec.ts";
import { fakeGateway } from "../../helpers/sandbox.ts";
import type { CommandEffect, FakeFs } from "../../helpers/sandbox-fs.ts";
import { freeSlots } from "../../helpers/slots.ts";
import {
  callCaps,
  run,
  scratchState,
  seedScratch,
  setup,
} from "../bash/helpers.ts";

function sandboxed(
  plays: Record<string, (fs: FakeFs) => CommandEffect | Promise<CommandEffect>>,
) {
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
    net: () => ({ mode: "hosts", hosts: ["pypi.org", "*.example.com"] }),
  });
  const backend = sandboxBackend({
    clock: wallClock,
    log: silent,
    limits: () => limits,
  });
  const s = setup({}, undefined, undefined, () => ({
    ownTmp: true,
    acquire: (call, deadline, signal) => leases.acquire(call, deadline, signal),
    run: backend.run,
  }));
  const files = () => [...fake.files.values()][0]!;
  return { s, fake, leases, backend, files, limits };
}

describe("the sandbox behind the mount", () => {
  test("a send's web access, all or listed, takes the sandbox's hosts, and off takes the network away", async () => {
    const t = sandboxed({});
    const hosts = () =>
      (
        (t.fake.policies.at(-1)?.network.web as {
          endpoints: { host: string }[];
        }) ?? { endpoints: [] }
      ).endpoints.map((endpoint) => endpoint.host);
    const web = (mode: "all" | "listed") => ({
      ...callCaps,
      web: { mode, domains: ["listed.test"] },
      fetchDeadlineMs: 1000,
      fetchBodyBytes: 1000,
    });
    try {
      await run(t.s, "noop", web("all"));
      await t.backend.idle();
      expect(hosts()).toEqual([
        "pypi.org",
        "pypi.org",
        "*.example.com",
        "*.example.com",
      ]);
      await run(t.s, "noop", web("listed"));
      await t.backend.idle();
      expect(t.fake.policies).toHaveLength(1);
      // web off, by the admin or the send's own switch: no endpoint, and
      // the sandbox that had hosts goes
      await run(t.s, "noop", callCaps);
      await t.backend.idle();
      expect(t.fake.deletes).toHaveLength(1);
      expect(t.fake.policies).toHaveLength(1);
    } finally {
      t.leases.close();
      t.s.db.close();
    }
  });

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
      expect(scratch.entries).toEqual([]);
      const doc = t.s.knowledge.store.mounted(t.s.projectId)[0]!;
      expect(new TextDecoder().decode(doc.data)).toBe("new\n");
      const tree = t.files().tree();
      // the stored text, BOM dropped, at the doc's time; /tmp as left
      expect(tree["/knowledge/a.md"]).toBe(`644 ${doc.updatedAt} new\n`);
      expect(tree["/tmp/s.txt"]).toBe("644 0 s");
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
      // a later used_at moves nothing in the sandbox either
      t.s.now.value += 1000;
      const later = t.files().calls.length;
      await run(t.s, "noop", callCaps);
      await t.backend.idle();
      expect(t.files().calls.slice(later)).not.toContain("push");
      expect(t.files().tree()["/tmp/s.txt"]).toBe("644 0 s");
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
      expect(scratchState(t.s).entries).toEqual([]);
      await t.backend.idle();
      expect(t.fake.deletes).toHaveLength(1);
    } finally {
      t.leases.close();
      t.s.db.close();
    }
  });

  test.serial(
    "the remote command holds no process slot, its read back does",
    async () => {
      const during: number[] = [];
      const t = sandboxed({
        wait: async () => {
          during.push(await freeSlots());
          return { stdout: "done\n" };
        },
      });
      // the walk, the first exec after the command, runs holding one
      const walking: number[] = [];
      const play = t.fake.onFiles!;
      t.fake.onFiles = (name, fs) => {
        play(name, fs);
        const exec = fs.exec.bind(fs);
        fs.exec = async function* (request) {
          if (request.command[4] === HELPER_SOURCES.walk)
            walking.push(await freeSlots());
          yield* exec(request);
        };
      };
      try {
        const result = await run(t.s, "wait", callCaps);
        expect(result.error).toBe(false);
        expect(during).toEqual([PROCESS_SLOTS]);
        expect(walking).toEqual([PROCESS_SLOTS - 1]);
        expect(await freeSlots()).toBe(PROCESS_SLOTS);
        await t.backend.idle();
      } finally {
        t.leases.close();
        t.s.db.close();
      }
    },
  );

  test("a command never writes or deletes a scratch row, whatever the cap", async () => {
    const t = sandboxed({
      churn: (fs) => {
        fs.write("/tmp/old.txt", "changed");
        fs.write("/tmp/new.txt", "new");
        fs.nodes.set("/tmp/link", { kind: "link", target: "/" });
        fs.write("/knowledge/a.md", "saved\n");
        return { pwd: "/tmp" };
      },
    });
    try {
      const data = new TextEncoder().encode("x".repeat(3000));
      seedScratch(t.s, {
        written: [
          { path: "old.txt", data, mode: 0o644 },
          { path: "gone.txt", data, mode: 0o600 },
          { path: "bad name", data, mode: 0o644 },
        ],
      });
      const before = scratchState(t.s);
      t.s.now.value += 60_000;
      // stored scratch over a lowered cap holds no sandbox command back
      t.limits.scratchBytes = 1000;
      t.limits.scratchFiles = 10;
      const result = await run(t.s, "churn", {
        ...callCaps,
        knowledge: true,
      });
      expect(result.error).toBe(false);
      expect(result.content).not.toContain("left out");
      await t.backend.idle();
      const after = scratchState(t.s);
      expect(after.entries).toEqual(before.entries);
      expect(after.cwd).toBe("/tmp");
      // the hidden rows age from their own last use
      expect(after.usedAt).toBe(before.usedAt!);
      // the rows were never pushed: the sandbox holds only its own
      expect(t.files().tree()["/tmp/gone.txt"]).toBeUndefined();
      expect(
        new TextDecoder().decode(
          t.s.knowledge.store.mounted(t.s.projectId)[0]!.data,
        ),
      ).toBe("saved\n");
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
