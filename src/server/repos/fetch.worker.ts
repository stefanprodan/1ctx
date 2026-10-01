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

self.onmessage = async (message: MessageEvent<FetchJob>) => {
  const result = await runJob(message.data, {
    fetch,
    emit: (event) => self.postMessage({ type: "event", event }),
  });
  self.postMessage({ type: "done", result } satisfies FetchMessage);
};
