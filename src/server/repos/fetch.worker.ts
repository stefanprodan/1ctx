// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A repository's fetch off the thread that serves: the request, the
// gunzip, the tar and the writes. One job per worker; the main thread
// ends it by terminate() at its deadline or at the drain, since the
// unpack's loops are synchronous between members.

import {
  type FetchJob,
  type JobEvent,
  type JobResult,
  runJob,
} from "./unpack.ts";

declare var self: Worker;

export type FetchMessage =
  | { type: "event"; event: JobEvent }
  | { type: "done"; result: JobResult };

// the main thread's answer to an event: whether to unpack
export type GoMessage = { type: "go"; go: boolean };

let answer: ((go: boolean) => void) | null = null;

self.onmessage = async (message: MessageEvent<FetchJob | GoMessage>) => {
  const data = message.data;
  if ("type" in data) {
    answer?.(data.go);
    answer = null;
    return;
  }
  const result = await runJob(data, {
    fetch,
    emit: (event) =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
        self.postMessage({ type: "event", event } satisfies FetchMessage);
      }),
  });
  self.postMessage({ type: "done", result } satisfies FetchMessage);
};
