// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server re-derives every decision from what it holds, the caps,
// the mounted rows and the job, and takes a command worker's answer as
// untrusted input: a fixture worker holding the job's id forges what a
// command able to post could. The bridge keeps what the shell did in
// one thread: a fetch curl gives up on ends alone, and a kept file that
// cannot be read fails the read.

import { describe, expect, test } from "bun:test";
import type { FetchResult, SecureFetch } from "just-bash";
import { commandFetch } from "../../../src/server/bash/credentials.ts";
import type { CommandCaps } from "../../../src/server/bash/mount.ts";
import type { Job } from "../../../src/server/bash/protocol.ts";
import { commandWorkers } from "../../../src/server/bash/worker.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { COMMAND_WORKER, callCaps, run, setup } from "./helpers.ts";

const FORGED = new URL("../../fixtures/bash/forged.worker.ts", import.meta.url);
const OUT =
  "nothing saved: the command worker answered out of protocol\nexit 0";
const all: CommandCaps = {
  ...callCaps,
  web: { mode: "all", domains: [] },
  fetchDeadlineMs: 1000,
  fetchBodyBytes: 1 << 20,
};

const job = (command: string, fields: Partial<Job> = {}): Job => ({
  command,
  endsAt: Date.now() + 10_000,
  docs: true,
  visuals: true,
  network: true,
  cwd: "/knowledge",
  knowledgeFileBytes: 1 << 20,
  mountBytes: 1 << 24,
  ioBytes: 1 << 20,
  iterations: 100_000,
  knowledge: [],
  scratch: [],
  uploads: [],
  kept: [],
  ...fields,
});
const stops = () => ({
  signal: new AbortController().signal,
  deadline: AbortSignal.timeout(10_000),
  chat: "chat",
});

describe("a command worker's answer is untrusted", () => {
  test("a forged fetch of a file: URL is refused on the server", async () => {
    const s = setup({}, FORGED);
    try {
      const result = await run(s, `fetch ${FORGED.href}`, all);
      expect(result.content).toContain("Network access denied");
      expect(result.content).not.toContain("declare var self");
    } finally {
      s.db.close();
    }
  });

  test("the server's fetch refuses every scheme but http and https", async () => {
    const fetch = commandFetch({ mode: "all", domains: [] }, [], {
      timeoutMs: 1000,
      maxResponseSize: 1024,
    });
    for (const url of [FORGED.href, "data:text/plain,x", "ftp://host/x"])
      await expect(fetch(url)).rejects.toThrow("only http and https");
  });

  test("a refusal that carries changes saves nothing", async () => {
    const s = setup({}, FORGED);
    try {
      const result = await run(s, "refused");
      expect(result).toMatchObject({
        error: true,
        content: "printed\nnothing saved: why\nexit 0",
      });
      expect(s.knowledge.list(s.projectId).files).toEqual([]);
      expect(s.bash.scratch.read(s.session.id).revision).toBe(0);
    } finally {
      s.db.close();
    }
  });

  test("a doc change with the docs off saves nothing", async () => {
    const s = setup({}, FORGED);
    try {
      const result = await run(s, "docs", { ...callCaps, knowledge: false });
      expect(result).toMatchObject({ error: true, content: OUT });
      expect(s.knowledge.list(s.projectId).files).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("an exit 124 discards whatever changes came with it", async () => {
    const s = setup({}, FORGED);
    try {
      const result = await run(s, "exit124");
      expect(result.error).toBe(true);
      expect(result.content).toContain(
        "nothing saved: command stopped at a deadline or limit",
      );
      expect(s.knowledge.list(s.projectId).files).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("an opened record passes only as open would make it", async () => {
    const s = setup({}, FORGED);
    try {
      expect((await run(s, "opened 1 visual 11")).opened).toHaveLength(1);
      for (const [command, caps] of [
        ["opened 11 visual 11", callCaps],
        ["opened 1 visual 0", callCaps],
        ["opened 1 visual 11", { ...callCaps, visuals: false }],
      ] as const) {
        const result = await run(s, command, caps);
        expect(result, command).toMatchObject({ error: true, content: OUT });
      }
    } finally {
      s.db.close();
    }
    const small = setup({ knowledgeFileBytes: 8 }, FORGED);
    try {
      expect(await run(small, "opened 1 visual 11")).toMatchObject({
        error: true,
        content: OUT,
      });
    } finally {
      small.db.close();
    }
  });
});

describe("the bridge keeps the shell's behaviour", () => {
  test("a fetch curl gives up on under timeout ends alone", async () => {
    let aborted = false;
    const slow: SecureFetch = (url, options) =>
      new Promise<FetchResult>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve({
              status: 200,
              statusText: "OK",
              headers: {},
              body: new TextEncoder().encode("late"),
              url,
            }),
          2000,
        );
        options?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            aborted = true;
            reject(new Error("The operation was aborted."));
          },
          { once: true },
        );
      });
    const workers = commandWorkers(COMMAND_WORKER, silent);
    const settled = await workers.run(
      job("timeout 0.05 curl https://slow.test/; echo after"),
      { kept: () => null, fetch: slow },
      stops(),
    );
    expect(settled).toMatchObject({
      ok: true,
      answer: { stdout: "after\n", exitCode: 0 },
    });
    for (let i = 0; i < 50 && !aborted; i++) await Bun.sleep(10);
    expect(aborted).toBe(true);
  });

  test("a kept file that cannot be read fails the read", async () => {
    const workers = commandWorkers(COMMAND_WORKER, silent);
    const path = "/mcp/0001-result/result.txt";
    const settled = await workers.run(
      job(`cp ${path} /knowledge/copy.md`, { kept: [path] }),
      {
        kept: () => {
          throw new Error("database read failed");
        },
        fetch: null,
      },
      stops(),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.answer.exitCode).not.toBe(0);
    expect(settled.answer.stderr).not.toContain("database read failed");
    expect(settled.answer.changes?.knowledge).toEqual([]);
  });
});
