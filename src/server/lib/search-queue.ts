// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One search scan at a time, server-wide, on the server's one thread.
// A scan yields to the event loop about every SEARCH_SLICE_MS through
// its step, so socket streams and timers run while it reads. Page
// searches go before /mcp ones, each in arrival order. A waiter leaves
// at its deadline or its abort, taking its job out of the queue; a
// running scan whose caller left stops at its next step.

import { HttpError, TooManyRequests } from "./errors.ts";

// under Bun's 10 s idleTimeout, so a waiter is answered, never dropped
export const SEARCH_WAIT_MS = 5000;
export const SEARCH_WAITERS = 64;
export const SEARCH_SLICE_MS = 8;
export const SEARCH_RETRY_S = 5;

export type SearchFrom = "page" | "mcp";

export type SearchAsk = { from: SearchFrom; signal?: AbortSignal };

// called before each unit of a scan's work: it may yield, and throws
// once the caller left
export type SearchStep = () => Promise<void>;

export type SearchQueue = {
  run<T>(ask: SearchAsk, scan: (step: SearchStep) => Promise<T>): Promise<T>;
  // how many wait now
  waiting(): number;
};

export type SearchQueueOptions = {
  waitMs: number;
  waiters: number;
  sliceMs: number;
  now: () => number;
};

// the answer to a search the queue cannot take or did not reach in time
export class SearchBusy extends TooManyRequests {
  constructor() {
    super(`search busy, retry in ${SEARCH_RETRY_S} s`, SEARCH_RETRY_S);
  }
}

// the caller left; nginx's 499, since nobody reads it
export class SearchCancelled extends HttpError {
  constructor() {
    super(499, "search cancelled");
  }
}

// a step for a scan run outside the queue
export const noStep: SearchStep = async () => {};

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

export function searchQueue(
  options: Partial<SearchQueueOptions> = {},
): SearchQueue {
  const waitMs = options.waitMs ?? SEARCH_WAIT_MS;
  const waiters = options.waiters ?? SEARCH_WAITERS;
  const sliceMs = options.sliceMs ?? SEARCH_SLICE_MS;
  const now = options.now ?? (() => performance.now());
  const queues: Record<SearchFrom, (() => void)[]> = { page: [], mcp: [] };
  let busy = false;
  const waiting = () => queues.page.length + queues.mcp.length;

  async function start<T>(
    ask: SearchAsk,
    scan: (step: SearchStep) => Promise<T>,
  ): Promise<T> {
    busy = true;
    let mark = now();
    const step: SearchStep = async () => {
      if (now() - mark >= sliceMs) {
        await turn();
        mark = now();
      }
      if (ask.signal?.aborted) throw new SearchCancelled();
    };
    try {
      if (ask.signal?.aborted) throw new SearchCancelled();
      return await scan(step);
    } finally {
      busy = false;
      (queues.page.shift() ?? queues.mcp.shift())?.();
    }
  }

  return {
    waiting,
    run(ask, scan) {
      if (ask.signal?.aborted) return Promise.reject(new SearchCancelled());
      if (!busy) return start(ask, scan);
      if (waiting() >= waiters) return Promise.reject(new SearchBusy());
      const queue = queues[ask.from];
      return new Promise((resolve, reject) => {
        const settle = () => {
          clearTimeout(deadline);
          ask.signal?.removeEventListener("abort", aborted);
        };
        const leave = (error: HttpError) => {
          const at = queue.indexOf(go);
          if (at >= 0) queue.splice(at, 1);
          settle();
          reject(error);
        };
        const go = () => {
          settle();
          start(ask, scan).then(resolve, reject);
        };
        const aborted = () => leave(new SearchCancelled());
        const deadline = setTimeout(() => leave(new SearchBusy()), waitMs);
        ask.signal?.addEventListener("abort", aborted, { once: true });
        queue.push(go);
      });
    },
  };
}
