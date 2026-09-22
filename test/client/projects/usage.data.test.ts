// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { me } from "../../../src/client/data/me.ts";
import {
  days,
  loadDays,
  loadWeek,
  week,
} from "../../../src/client/data/usage.ts";
import type {
  DaysUsageResponse,
  WeekUsageResponse,
} from "../../../src/shared/api/usage.ts";

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let user = 0;

const weekOne: WeekUsageResponse = {
  since: 1,
  until: 2,
  sends: 5,
  sessions: 2,
  promptTokens: 3,
  completionTokens: 4,
};

function dayAnswer(
  sends: number,
  until = Date.now() + 60_000,
): DaysUsageResponse {
  return {
    since: 1,
    until,
    days: ["2026-09-14"],
    total: { sends, tokens: sends * 10 },
    projects: [
      {
        projectId: "p1",
        usage: [{ sends, tokens: sends * 10 }],
      },
    ],
  };
}

function signIn(): void {
  user++;
  me.value = {
    id: `u${user}`,
    username: "casey",
    fullName: "Casey",
    role: "member",
    mustChangePassword: false,
  };
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (body: unknown) => void;
} {
  let release: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: (body) => release(Response.json(body)),
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => realSetTimeout(resolve, 0));
}

beforeEach(() => {
  signIn();
});

afterEach(async () => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  me.value = undefined;
  await settle();
  globalThis.fetch = realFetch;
});

describe("the usage entities", () => {
  test.serial("week then days keeps both answers", async () => {
    const weekGate = deferredResponse();
    const daysGate = deferredResponse();
    globalThis.fetch = ((url: string) =>
      url.startsWith("/api/usage/week?tz=")
        ? weekGate.promise
        : daysGate.promise) as unknown as typeof fetch;

    const loadingWeek = loadWeek();
    const loadingDays = loadDays();
    weekGate.resolve(weekOne);
    await loadingWeek;
    expect(week.value).toEqual(weekOne);
    expect(days.value).toBeNull();

    const activity = dayAnswer(5);
    daysGate.resolve(activity);
    await loadingDays;
    expect(week.value).toEqual(weekOne);
    expect(days.value).toEqual(activity);
  });

  test.serial("days then week keeps both answers", async () => {
    const weekGate = deferredResponse();
    const daysGate = deferredResponse();
    globalThis.fetch = ((url: string) =>
      url.startsWith("/api/usage/week?tz=")
        ? weekGate.promise
        : daysGate.promise) as unknown as typeof fetch;

    const loadingWeek = loadWeek();
    const loadingDays = loadDays();
    const activity = dayAnswer(7);
    daysGate.resolve(activity);
    await loadingDays;
    expect(days.value).toEqual(activity);
    expect(week.value).toBeNull();

    weekGate.resolve(weekOne);
    await loadingWeek;
    expect(days.value).toEqual(activity);
    expect(week.value).toEqual(weekOne);
  });

  test.serial("a user change drops a late day answer", async () => {
    const gate = deferredResponse();
    globalThis.fetch = (() => gate.promise) as unknown as typeof fetch;

    const loading = loadDays();
    signIn();
    expect(days.value).toBeNull();

    gate.resolve(dayAnswer(9));
    await loading;
    expect(days.value).toBeNull();
  });

  test.serial(
    "midnight reloads days and a user change clears the timer",
    async () => {
      let timerId = 0;
      const timers = new Map<
        number,
        { handler: () => void; delay: number | undefined }
      >();
      const cleared: number[] = [];
      globalThis.setTimeout = ((
        handler: TimerHandler,
        delay?: number,
      ): ReturnType<typeof setTimeout> => {
        const id = ++timerId;
        if (typeof handler !== "function")
          throw new Error("timer is not a function");
        timers.set(id, { handler: () => handler(), delay });
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout;
      globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
        const value = Number(id);
        cleared.push(value);
        timers.delete(value);
      }) as typeof clearTimeout;

      let calls = 0;
      const urls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        calls++;
        urls.push(url);
        return Response.json(dayAnswer(calls, Date.now() + 1_000));
      }) as unknown as typeof fetch;

      await loadDays();
      expect(calls).toBe(1);
      expect(timers.size).toBe(1);
      const first = [...timers.entries()][0];
      // a midnight a second away still waits the minute, so a server
      // clock behind the browser's never loops the reload
      expect(first[1].delay).toBe(60_000);
      expect(urls[0]).toBe(
        `/api/usage/days?tz=${encodeURIComponent(
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        )}`,
      );

      timers.delete(first[0]);
      first[1].handler();
      await settle();
      expect(calls).toBe(2);
      expect(days.value?.total.sends).toBe(2);
      expect(timers.size).toBe(1);

      // a refresh that fails keeps the chart and tries again
      globalThis.fetch = (async () =>
        new Response("down", { status: 503 })) as unknown as typeof fetch;
      const [pendingId, pending] = [...timers.entries()][0];
      timers.delete(pendingId);
      pending.handler();
      await settle();
      expect(days.value?.total.sends).toBe(2);
      expect(timers.size).toBe(1);
      expect([...timers.values()][0].delay).toBe(60_000);

      const secondId = [...timers.keys()][0];
      signIn();
      expect(days.value).toBeNull();
      expect(cleared).toContain(secondId);
      expect(timers.size).toBe(0);
    },
  );
});
