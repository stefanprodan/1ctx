// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Overview's load keeps only the latest word: a slower answer for
// another range, or one for a user who left, never lands over it, and a
// failed refresh keeps the answer on screen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { me } from "../../../src/client/data/me.ts";
import {
  loadOverview,
  overview,
  overviewError,
  overviewLoading,
  overviewRange,
} from "../../../src/client/data/overview.ts";
import type { OverviewResponse } from "../../../src/shared/api/admin.ts";

const realFetch = globalThis.fetch;

const body = (readAt: number) => ({ readAt }) as unknown as OverviewResponse;

// each call waits for its own release, so a test picks the order
function held() {
  const calls: { url: string; answer: (res: Response) => void }[] = [];
  globalThis.fetch = ((url: string) =>
    new Promise<Response>((answer) => {
      calls.push({ url: String(url), answer });
    })) as unknown as typeof fetch;
  return calls;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey",
    role: "admin",
    mustChangePassword: false,
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  me.value = undefined;
});

describe("loadOverview", () => {
  test.serial("a later range wins over a slower earlier one", async () => {
    const calls = held();
    const first = loadOverview(30);
    const second = loadOverview(7);
    expect(calls[0].url).toContain("days=30");
    expect(calls[1].url).toContain("days=7");
    calls[1].answer(json(body(7)));
    await second;
    calls[0].answer(json(body(30)));
    await first;
    expect(overview.value?.readAt).toBe(7);
    expect(overviewRange.value).toBe(7);
    expect(overviewLoading.value).toBe(false);
  });

  test.serial("a failed refresh keeps the answer on screen", async () => {
    const calls = held();
    const load = loadOverview(7);
    calls[0].answer(json(body(1)));
    await load;
    const again = loadOverview(7);
    calls[1].answer(json({ error: "scan timed out" }, 500));
    await again;
    expect(overview.value?.readAt).toBe(1);
    expect(overviewError.value?.words).toBe("scan timed out");
    expect(overviewError.value?.status).toBe(500);
  });

  test.serial("an answer for a user who left is dropped", async () => {
    const calls = held();
    const load = loadOverview(30);
    me.value = {
      id: "u2",
      username: "other",
      fullName: "Other",
      role: "admin",
      mustChangePassword: false,
    };
    await settle();
    calls[0].answer(json(body(9)));
    await load;
    expect(overview.value).toBeNull();
    expect(overviewLoading.value).toBe(false);
  });
});
