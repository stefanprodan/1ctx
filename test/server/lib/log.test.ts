// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  errorFields,
  format,
  type LogFields,
  scrubErrors,
} from "../../../src/server/lib/log.ts";

const at = new Date("2026-09-21T22:39:12.345Z");

describe("log format", () => {
  test("matches Go slog text quoting", () => {
    expect(
      format(at, "runner", "info", "send end", {
        a: "plain",
        b: "",
        c: "two words",
        d: "a=b",
        e: "a\\b",
        f: "a\x7fb",
        g: "a\nb",
        h: "a\tb",
        i: 'quote"here',
        j: "nonbreaking\u00a0space",
        k: "zero\u200bwidth",
        l: "snowman☃",
        m: "line\u2028separator",
        n: "bad\ud800x",
      }),
    ).toBe(
      'time=2026-09-21T22:39:12.345Z level=INFO msg="send end" area=runner a=plain b="" c="two words" d="a=b" e=a\\b f=a\x7fb g="a\\nb" h="a\\tb" i="quote\\"here" j="nonbreaking\\u00a0space" k="zero\\u200bwidth" l=snowman☃ m="line\\u2028separator" n="bad\\xed\\xa0\\x80x"',
    );
  });

  test("keeps field order, formats milliseconds and reports bad fields", () => {
    const fields = {
      count: 1_000_000,
      duration: 123.5,
      enabled: true,
      empty: undefined,
      time: "wrong",
      "bad-key": "wrong",
      infinite: Number.POSITIVE_INFINITY,
      object: null,
    } as unknown as LogFields;
    expect(format(at, "web", "warn", "request", fields)).toBe(
      "time=2026-09-21T22:39:12.345Z level=WARN msg=request area=web count=1e+06 duration=124ms enabled=true bad_fields=4",
    );
    expect(format(at, "web", "info", "quick", { duration: 0.49 })).toEndWith(
      "duration=0ms",
    );
  });
});

describe("error fields", () => {
  test("cuts one line, cleans URLs and keeps typed details", () => {
    const error = Object.assign(
      new TypeError(
        `failed https://user:pass@fault.test/path?q=private\n${"x".repeat(300)}`,
      ),
      { code: "ETIMEDOUT", status: 503, retry: true },
    );
    expect(errorFields(error, false)).toEqual({
      error_type: "TypeError",
      error: "failed https://fault.test/path",
      error_code: "ETIMEDOUT",
      status: 503,
      retry: true,
    });
  });

  test("cuts the error at 200 characters when it is written", () => {
    expect(format(at, "a", "error", "b", { error: "x".repeat(200) })).toBe(
      `time=2026-09-21T22:39:12.345Z level=ERROR msg=b area=a error=${"x".repeat(200)}`,
    );
    expect(format(at, "a", "error", "b", { error: "x".repeat(201) })).toBe(
      `time=2026-09-21T22:39:12.345Z level=ERROR msg=b area=a error=${"x".repeat(197)}...`,
    );
  });

  test("scrubs a key the cut would have split", () => {
    const key = "sk-straddling-the-cut-0123456789";
    const lines: LogFields[] = [];
    const log = scrubErrors(
      {
        info() {},
        warn() {},
        error: (_msg, fields) => {
          lines.push(fields ?? {});
        },
      },
      () => [key],
    );
    log.error("b", errorFields(new Error(`${"x".repeat(190)}${key}`), false));
    const line = format(at, "a", "error", "b", lines[0]);
    expect(line).not.toContain(key.slice(0, 7));
    expect(line).toContain("[key]");
  });

  test("keeps only source frame locations", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at inner (/repo/src/server/sessions/store.ts:212:9)",
      "    at next (/repo/src/shared/words.ts:88:3)",
      "    at test (/repo/test/example.test.ts:4:1)",
    ].join("\n");
    expect(errorFields(error).stack).toBe(
      "sessions/store.ts:212 shared/words.ts:88",
    );
  });

  test("reads the relative frames of a binary built with a sourcemap", () => {
    const error = new TypeError("boom");
    error.stack = [
      "TypeError: boom",
      "    at boom (src/server/lib/b.ts:1:55)",
      "    at src/server/main.ts:2:5",
    ].join("\n");
    expect(errorFields(error).stack).toBe("lib/b.ts:1 main.ts:2");
  });

  test("never reads a frame out of the message's later lines", () => {
    const error = new Error("first\n    at fake (/x/src/server/secret.ts:1:1)");
    error.stack = [
      "Error: first",
      "    at fake (/x/src/server/secret.ts:1:1)",
      "    at real (/x/src/server/web/router.ts:9:2)",
    ].join("\n");
    expect(errorFields(error).stack).toBe("web/router.ts:9");
  });
});
