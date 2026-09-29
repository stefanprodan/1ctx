// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { retryAfterMs } from "../../../src/server/providers/openai.ts";
import {
  MAX_RETRY_AFTER_MS,
  retryWait,
} from "../../../src/server/runner/retry.ts";

type ErrorEvent = Parameters<typeof retryWait>[0];

const refused = (status: number, extra: Partial<ErrorEvent> = {}) =>
  ({ kind: "error", message: `HTTP ${status}`, status, ...extra }) as const;
const fresh = { retries: 0, timeouts: 0 };

describe("which failures are asked again", () => {
  test.each([429, 500, 502, 503, 504])("%i is retried", (status) => {
    expect(retryWait(refused(status), fresh, null, 0)).toBe(1000);
  });

  test.each([400, 401, 403, 404, 413, 422, 501, 505])(
    "%i fails at once",
    (status) => {
      expect(retryWait(refused(status), fresh, null, 0)).toBeNull();
    },
  );

  test("a failed connection is retried", () => {
    const event = {
      kind: "error",
      message: "local failed: refused",
      unanswered: true,
    } as const;
    expect(retryWait(event, fresh, null, 0)).toBe(1000);
  });

  test("an error with no status fails at once", () => {
    for (const message of [
      "stream ended early",
      "invalid JSON in the stream",
      "local has no key file provider-local.key",
    ]) {
      expect(retryWait({ kind: "error", message }, fresh, null, 0)).toBeNull();
    }
  });

  test("a headers timeout is retried once", () => {
    const event = {
      kind: "error",
      message: "the response headers timed out",
      unanswered: true,
      timedOut: true,
    } as const;
    expect(retryWait(event, fresh, null, 0)).toBe(1000);
    expect(retryWait(event, { retries: 1, timeouts: 1 }, null, 0)).toBeNull();
    // a timeout after a refusal still has its one retry
    expect(retryWait(event, { retries: 1, timeouts: 0 }, null, 0)).toBe(2000);
  });

  test("three retries at most", () => {
    const state = (retries: number) => ({ retries, timeouts: 0 });
    expect(retryWait(refused(503), state(2), null, 0)).toBe(4000);
    expect(retryWait(refused(503), state(3), null, 0)).toBeNull();
  });
});

describe("how long a retry waits", () => {
  test("about 1, 2 and 4 s with up to a quarter of jitter", () => {
    for (const [retries, base] of [
      [0, 1000],
      [1, 2000],
      [2, 4000],
    ] as const) {
      const state = { retries, timeouts: 0 };
      expect(retryWait(refused(503), state, null, 0)).toBe(base);
      expect(retryWait(refused(503), state, null, 0.5)).toBe(base * 1.125);
      const most = retryWait(refused(503), state, null, 0.999_999)!;
      expect(most).toBeGreaterThan(base);
      expect(most).toBeLessThanOrEqual(base * 1.25);
    }
  });

  test("a Retry-After only lengthens the backoff, up to 30 s", () => {
    const after = (ms: number) => refused(429, { retryAfterMs: ms });
    expect(retryWait(after(2000), fresh, null, 0)).toBe(2000);
    expect(retryWait(after(2000), fresh, null, 0.5)).toBe(2250);
    // no wait asked, or a past date, still backs off with its jitter
    expect(retryWait(after(0), fresh, null, 0)).toBe(1000);
    expect(retryWait(after(0), fresh, null, 0.5)).toBe(1125);
    expect(retryWait(after(1500), { retries: 2, timeouts: 0 }, null, 0)).toBe(
      4000,
    );
    expect(retryWait(after(MAX_RETRY_AFTER_MS), fresh, null, 0)).toBe(30_000);
    expect(retryWait(after(MAX_RETRY_AFTER_MS + 1), fresh, null, 0)).toBeNull();
  });

  test("sends refused together come back apart", () => {
    const waits = [0, 0.3, 0.7].map((random) =>
      retryWait(refused(429, { retryAfterMs: 0 }), fresh, null, random),
    );
    expect(new Set(waits).size).toBe(3);
  });

  test("a wait that would pass the deadline is not started", () => {
    expect(retryWait(refused(503), fresh, 1001, 0)).toBe(1000);
    expect(retryWait(refused(503), fresh, 1000, 0)).toBeNull();
    expect(retryWait(refused(503), fresh, -5, 0)).toBeNull();
    const after = refused(429, { retryAfterMs: 10_000 });
    expect(retryWait(after, fresh, 9_000, 0)).toBeNull();
  });
});

describe("Retry-After", () => {
  const now = Date.parse("2026-09-29T10:00:00Z");

  test("seconds", () => {
    expect(retryAfterMs("2", now)).toBe(2000);
    expect(retryAfterMs(" 0 ", now)).toBe(0);
    expect(retryAfterMs("120", now)).toBe(120_000);
  });

  test("an HTTP date, from now", () => {
    expect(retryAfterMs("Tue, 29 Sep 2026 10:00:05 GMT", now)).toBe(5000);
    expect(retryAfterMs("Tue, 29 Sep 2026 09:59:00 GMT", now)).toBe(0);
  });

  test("anything else is no Retry-After", () => {
    for (const header of [
      null,
      "",
      "-1",
      "1.5",
      "soon",
      "2 s",
      "May 1",
      "x 5",
      "2026-09-29T10:00:05Z",
      "Tuesday, 29-Sep-26 10:00:05 GMT",
      "Tue, 29 Sep 2026 10:00:05 PST",
    ]) {
      expect(retryAfterMs(header, now)).toBeNull();
    }
  });
});
