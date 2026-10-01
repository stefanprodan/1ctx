// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The main thread's side of the fetch worker: a worker per job, ended
// when it answers, at its deadline or when the area closes. The worker
// file is an entry of the compiled binary, so compose.ts builds its URL.

import type { FetchMessage, GoMessage } from "./fetch.worker.ts";
import {
  type FetchJob,
  type JobEvent,
  type JobResult,
  runJob,
} from "./unpack.ts";

export type JobRunner = (
  job: FetchJob,
  // for a tree not published, whether to unpack it
  onEvent: (event: JobEvent) => boolean | Promise<boolean>,
  signal: AbortSignal,
) => Promise<JobResult>;

const ended: JobResult = { ok: false, error: "host unreachable", status: null };

export function workerJobs(url: URL): JobRunner {
  return (job, onEvent, signal) =>
    new Promise<JobResult>((resolve) => {
      if (signal.aborted) return resolve(ended);
      const worker = new Worker(url);
      let done = false;
      const finish = (result: JobResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        worker.terminate();
        resolve(result);
      };
      const stop = () => finish(ended);
      // the worker's own deadline cannot cut a synchronous loop
      let timer = setTimeout(stop, job.deadlineMs);
      signal.addEventListener("abort", stop, { once: true });
      worker.onmessage = (message: MessageEvent<FetchMessage>) => {
        if (message.data.type === "done") return finish(message.data.result);
        // the deadline waits while the caller takes its slots, then
        // starts again, as the worker's does
        clearTimeout(timer);
        void Promise.resolve(onEvent(message.data.event)).then((go) => {
          if (done) return;
          timer = setTimeout(stop, job.deadlineMs);
          worker.postMessage({ type: "go", go } satisfies GoMessage);
        });
      };
      worker.onerror = stop;
      worker.postMessage(job);
    });
}

// the same job on this thread, for a test with a fake fetch
export function threadJobs(fetcher: typeof fetch): JobRunner {
  return (job, onEvent, signal) =>
    runJob(job, { fetch: fetcher, emit: onEvent, signal });
}
