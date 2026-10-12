// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The search queue: one scan at a time, page searches first, a waiter
// that leaves takes its job out, a bound per lane and a deadline that
// answer busy, and scans that yield, alone or in a backlog, and stop
// once their caller left.

import { describe, expect, test } from "bun:test";
import { HttpError } from "../../../src/server/lib/errors.ts";
import {
  SEARCH_RETRY_S,
  SearchBusy,
  SearchCancelled,
  type SearchStep,
  searchQueue,
} from "../../../src/server/lib/search-queue.ts";

// a scan that holds the queue until released
function held() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected a refusal");
}

describe("the search queue", () => {
  test("runs one scan at a time, page searches before queued /mcp ones", async () => {
    const queue = searchQueue();
    const order: string[] = [];
    let running = 0;
    let most = 0;
    const job = (name: string) => async () => {
      running++;
      most = Math.max(most, running);
      await settle();
      order.push(name);
      running--;
      return name;
    };
    const first = held();
    const holding = queue.run({ from: "mcp" }, async () => {
      await first.gate;
      order.push("first");
    });
    const jobs = [
      queue.run({ from: "mcp" }, job("mcp-1")),
      queue.run({ from: "mcp" }, job("mcp-2")),
      queue.run({ from: "page" }, job("page-1")),
      queue.run({ from: "page" }, job("page-2")),
    ];
    expect(queue.waiting()).toBe(4);
    first.release();
    await holding;
    expect(await Promise.all(jobs)).toEqual([
      "mcp-1",
      "mcp-2",
      "page-1",
      "page-2",
    ]);
    expect(order).toEqual(["first", "page-1", "page-2", "mcp-1", "mcp-2"]);
    expect(most).toBe(1);
    expect(queue.waiting()).toBe(0);
  });

  test("twenty /mcp searches on one key all succeed within the wait", async () => {
    const queue = searchQueue({ waitMs: 1000 });
    let running = 0;
    let most = 0;
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        queue.run({ from: "mcp" }, async (step) => {
          running++;
          most = Math.max(most, running);
          for (let n = 0; n < 3; n++) await step();
          await settle();
          running--;
          return i;
        }),
      ),
    );
    expect(answers).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(most).toBe(1);
  });

  test("past a lane's bound a search is refused at once with when to retry", async () => {
    const queue = searchQueue({ waiters: 2 });
    const first = held();
    const holding = queue.run({ from: "mcp" }, () => first.gate);
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(name);
      return name;
    };
    const waiting = [
      queue.run({ from: "mcp" }, job("mcp-1")),
      queue.run({ from: "mcp" }, job("mcp-2")),
    ];
    const refused = await failure(queue.run({ from: "mcp" }, job("mcp-3")));
    expect(refused).toBeInstanceOf(SearchBusy);
    expect(refused.status).toBe(429);
    expect(refused.message).toBe(`search busy, retry in ${SEARCH_RETRY_S} s`);
    expect((refused as SearchBusy).retryAfter).toBe(SEARCH_RETRY_S);
    // the /mcp lane is full; the page lane still takes a search, first
    const page = [
      queue.run({ from: "page" }, job("page-1")),
      queue.run({ from: "page" }, job("page-2")),
    ];
    expect(
      await failure(queue.run({ from: "page" }, job("page-3"))),
    ).toBeInstanceOf(SearchBusy);
    expect(queue.waiting("mcp")).toBe(2);
    expect(queue.waiting("page")).toBe(2);
    first.release();
    await holding;
    expect(await Promise.all([...waiting, ...page])).toEqual([
      "mcp-1",
      "mcp-2",
      "page-1",
      "page-2",
    ]);
    expect(order).toEqual(["page-1", "page-2", "mcp-1", "mcp-2"]);
  });

  test("a waiter past its deadline leaves busy, its job never run", async () => {
    const queue = searchQueue({ waitMs: 20 });
    const first = held();
    const holding = queue.run({ from: "mcp" }, () => first.gate);
    let ran = false;
    const late = await failure(
      queue.run({ from: "mcp" }, async () => {
        ran = true;
      }),
    );
    expect(late).toBeInstanceOf(SearchBusy);
    expect(queue.waiting()).toBe(0);
    first.release();
    await holding;
    await settle();
    expect(ran).toBe(false);
  });

  test("a waiter that aborts takes its job out of the queue", async () => {
    const queue = searchQueue();
    const first = held();
    const holding = queue.run({ from: "mcp" }, () => first.gate);
    const caller = new AbortController();
    let ran = false;
    const leaving = queue.run(
      { from: "page", signal: caller.signal },
      async () => {
        ran = true;
      },
    );
    const after = queue.run({ from: "mcp" }, async () => "after");
    expect(queue.waiting()).toBe(2);
    caller.abort();
    const left = await failure(leaving);
    expect(left).toBeInstanceOf(SearchCancelled);
    expect(left.status).toBe(499);
    expect(queue.waiting()).toBe(1);
    first.release();
    await holding;
    expect(await after).toBe("after");
    expect(ran).toBe(false);
  });

  test("a running scan whose caller left stops at its next yield", async () => {
    let clock = 0;
    const queue = searchQueue({ sliceMs: 8, now: () => clock });
    const caller = new AbortController();
    let units = 0;
    const scan = async (step: SearchStep) => {
      for (let n = 0; n < 100; n++) {
        await step();
        units++;
        clock += 3;
        if (units === 2) setImmediate(() => caller.abort());
      }
      return units;
    };
    const stopped = await failure(
      queue.run({ from: "mcp", signal: caller.signal }, scan),
    );
    expect(stopped).toBeInstanceOf(SearchCancelled);
    // the clock passes the slice after three units: the yield there is
    // where the abort lands
    expect(units).toBe(3);
    expect(await queue.run({ from: "mcp" }, async () => "next")).toBe("next");
  });

  test("work queued before a long scan runs at its first yield", async () => {
    let clock = 0;
    const queue = searchQueue({ sliceMs: 8, now: () => clock });
    let ranAfter = -1;
    let units = 0;
    // a yield is a setImmediate turn, so this runs at the first one
    setImmediate(() => {
      ranAfter = units;
    });
    await queue.run({ from: "page" }, async (step) => {
      for (let n = 0; n < 12; n++) {
        await step();
        units++;
        clock += 3;
      }
    });
    expect(units).toBe(12);
    // the clock reaches the slice after three units
    expect(ranAfter).toBe(3);
  });

  test("a backlog of short scans yields once the queue's slice is spent", async () => {
    let clock = 0;
    const queue = searchQueue({ sliceMs: 8, now: () => clock });
    let ranAfter = -1;
    let done = 0;
    setImmediate(() => {
      ranAfter = done;
    });
    // each scan is shorter than a slice
    const scans = Array.from({ length: 20 }, () =>
      queue.run({ from: "mcp" }, async (step) => {
        await step();
        clock += 5;
        done++;
      }),
    );
    await Promise.all(scans);
    expect(done).toBe(20);
    // the slice is the queue's, spent on the third scan's step; a fresh
    // slice per scan would never yield before all twenty
    expect(ranAfter).toBe(2);
  });

  test("an aborted caller is refused before it waits or runs", async () => {
    const queue = searchQueue();
    const caller = new AbortController();
    caller.abort();
    let ran = false;
    const refused = await failure(
      queue.run({ from: "page", signal: caller.signal }, async () => {
        ran = true;
      }),
    );
    expect(refused).toBeInstanceOf(SearchCancelled);
    expect(ran).toBe(false);
  });
});
