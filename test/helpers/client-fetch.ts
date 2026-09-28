// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach } from "bun:test";
import { deferred } from "./async.ts";

type Answer = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function clientFetch(answer: Answer) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
    calls.length = 0;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push({ url, init });
        return answer(url, init);
      },
      {
        preconnect() {
          throw new Error("unexpected fetch preconnect");
        },
      },
    );
  });
  afterEach(() => {
    globalThis.fetch = original;
  });
  return calls;
}

export function deferredFetch() {
  const calls: { url: string; answer: (response: Response) => void }[] = [];
  beforeEach(() => {
    calls.length = 0;
  });
  clientFetch((url) => {
    const held = deferred<Response>();
    calls.push({ url, answer: held.resolve });
    return held.promise;
  });
  return calls;
}
