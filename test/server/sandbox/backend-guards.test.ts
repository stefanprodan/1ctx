// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the sandbox's read back refuses before anything is saved: names
// no row could hold, records past a path's bound, a read back that ends
// past the deadline, and the pull's own bounds, its batches and its stop
// at the first refusal.

import { describe, expect, test } from "bun:test";
import type { CommandCredential } from "../../../src/server/bash/index.ts";
import { pull, StepFailure } from "../../../src/server/sandbox/execs.ts";
import {
  escapePath,
  PUSH_CHUNK_BYTES,
} from "../../../src/server/sandbox/frames.ts";
import type {
  ExecEvent,
  ExecRequest,
  Gateway,
} from "../../../src/server/sandbox/gateway.ts";
import { decodePull, pullBatches } from "../../../src/server/sandbox/pull.ts";
import { answerOf, setup } from "./backend-helpers.ts";

const KEY = "made-up-key-0123456789abcdef";
const credential: CommandCredential = {
  name: "quotes",
  prefix: "https://api.example.test/v1/",
  key: KEY,
  header: "Authorization",
  template: "Bearer {key}",
  value: `Bearer ${KEY}`,
  methods: ["GET"],
};
const web = { mode: "listed" as const, domains: ["api.example.test"] };
const ROWS = { knowledge: { "a.md": "a\n" }, scratch: { "s.txt": "s" } };

describe("the sandbox's read back refuses", () => {
  test("a saved name holding a key, in any spelling the scrub knows", async () => {
    for (const path of [
      `/tmp/${KEY}.json`,
      `/knowledge/got-${KEY}.md`,
      `/tmp/${KEY.replaceAll("-", "\\u002d")}`,
    ]) {
      const t = setup();
      const ran = await t.run(
        { ...ROWS, web, credentials: [credential] },
        ({ fs }) => {
          fs.write(path, "x");
          fs.write("/tmp/kept.txt", "y");
          return {};
        },
      );
      const answer = answerOf(ran.settled);
      expect(answer.changes).toBeNull();
      expect(answer.refused).toBe(
        "a file name held a credential, so nothing was saved",
      );
      expect(JSON.stringify(answer)).not.toContain(KEY);
      ran.settle({ landed: false, why: "skipped" });
      expect(await t.settled(ran.hold)).not.toBe("idle");
    }
  });

  test("a saved name that is not UTF-8", async () => {
    // the fake names its node by the lossy spelling, the walk lists the
    // raw bytes, as a real walk lists a name the command made
    const lossy = "/tmp/bad�";
    const t = setup();
    const ran = await t.run(ROWS, ({ fs }) => {
      fs.write(lossy, "x");
      fs.walkLines = (lines) =>
        lines.map((line) =>
          line.replace(escapePath(lossy), `${escapePath("/tmp/bad")}%FF`),
        );
      return {};
    });
    const answer = answerOf(ran.settled);
    expect(answer.changes).toBeNull();
    expect(answer.refused).toBe(
      "a file name is not UTF-8, so nothing was saved",
    );
    ran.settle({ landed: false, why: "skipped" });
    expect(await t.settled(ran.hold)).not.toBe("idle");
  });

  test("a cwd or an opened path record past a path's bound", async () => {
    for (const effect of [
      { pwd: `/tmp/${"a".repeat(9000)}` },
      { opened: [{ path: `/tmp/${"b".repeat(30_000)}`, text: "t" }] },
    ]) {
      const t = setup();
      const ran = await t.run(ROWS, effect);
      const answer = answerOf(ran.settled);
      expect(answer.changes).toBeNull();
      expect(answer.refused).toBe(
        "the files could not be read back, so nothing was saved",
      );
      ran.settle({ landed: false, why: "skipped" });
      expect(await t.settled(ran.hold)).not.toBe("idle");
    }
  });

  test("a read back that ends past the deadline, as a deadline", async () => {
    const t = setup();
    const ran = await t.run(ROWS, ({ fs }) => {
      fs.write("/tmp/s.txt", "changed");
      // the time passes once the last exec, the records' removal, ended
      const exec = fs.exec.bind(fs);
      fs.exec = async function* (request) {
        yield* exec(request);
        if (request.command[0] === "/usr/bin/find") t.time.advance(30_000);
      };
      return { stdout: "out" };
    });
    expect(answerOf(ran.settled)).toMatchObject({
      stdout: "out",
      exitCode: 124,
      changes: null,
      refused: null,
    });
    ran.settle({ landed: false, why: "skipped" });
    expect(await t.settled(ran.hold)).not.toBe("idle");
  });
});

describe("the sandbox's pull", () => {
  test("many long names go in batches, each under the request limit", async () => {
    // 15 folders of 240 bytes and a file name: 100 paths of about 11 KiB
    // escaped, past one request together
    const deep = Array.from({ length: 15 }, () => "é".repeat(120)).join("/");
    const t = setup();
    const ran = await t.run(ROWS, ({ fs }) => {
      for (let n = 0; n < 100; n++) fs.write(`/tmp/${deep}/${n}`, String(n));
      return {};
    });
    const answer = answerOf(ran.settled);
    expect(answer.refused).toBeNull();
    expect(answer.changes?.written).toHaveLength(100);
    expect(ran.fs.pulled.length).toBeGreaterThan(1);
    for (const stdin of ran.fs.pulled)
      expect(stdin.byteLength).toBeLessThan(PUSH_CHUNK_BYTES);
    ran.settle({ landed: false, why: "skipped" });
  });

  test("batches split before the limit and keep every path in order", () => {
    const paths = ["/tmp/a", "/tmp/bb", "/tmp/ccc", "/tmp/d"];
    expect(pullBatches(paths, 17)).toEqual([
      ["/tmp/a", "/tmp/bb"],
      ["/tmp/ccc", "/tmp/d"],
    ]);
    expect(pullBatches([], 17)).toEqual([]);
    expect(() => pullBatches(["/tmp/too-long-path"], 17)).toThrow(RangeError);
  });

  test("a record past its own bound is refused before its bytes", () => {
    const escaped = escapePath("/sandbox/.1ctx/x.cwd");
    const header = `${JSON.stringify({ path: escaped, size: 5000, mode: 0o644 })}\n`;
    const result = decodePull(
      new TextEncoder().encode(header),
      ["/sandbox/.1ctx"],
      {
        fileBytes: 1 << 20,
        totalBytes: 1 << 20,
        paths: new Map([[escaped, 4096]]),
      },
      [escaped],
    );
    expect(result).toEqual({ ok: false, reason: "file", frame: 0 });
  });

  test("the exec ends at the decoder's first refusal, unread", async () => {
    const escaped = escapePath("/tmp/big");
    let after = 0;
    let request: ExecRequest | null = null;
    const gateway = {
      async *exec(asked: ExecRequest): AsyncGenerator<ExecEvent> {
        request = asked;
        yield {
          stream: "stdout",
          data: new TextEncoder().encode(
            `${JSON.stringify({ path: escaped, size: 1 << 30, mode: 0o644 })}\n`,
          ),
        };
        for (;;) {
          after++;
          yield { stream: "stdout", data: new Uint8Array(1 << 16) };
        }
      },
    } as unknown as Gateway;
    const on = { gateway, sandbox: "s", signal: new AbortController().signal };
    let failure: unknown = null;
    try {
      await pull(on, [escaped], { fileBytes: 100, totalBytes: 100 }, ["/tmp"]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StepFailure);
    expect((failure as StepFailure).reason).toBe("file");
    expect(after).toBe(0);
    const sent = request as ExecRequest | null;
    expect(sent?.signal.aborted).toBe(true);
    // the helper is told the cap, so it refuses the file itself
    expect(sent?.command.slice(5)).toEqual(["100", "/tmp"]);
  });
});
