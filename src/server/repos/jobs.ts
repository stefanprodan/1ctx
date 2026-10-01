// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The main thread's side of the fetch worker: a worker per job, ended
// when it answers, at its deadline or when the area closes. The worker
// file is an entry of the compiled binary, so compose.ts builds its URL.

import type { FetchMessage } from "./fetch.worker.ts";
import {
  type FetchJob,
  type JobEvent,
  type JobResult,
  runJob,
} from "./unpack.ts";

export type JobRunner = (
  job: FetchJob,
  onEvent: (event: JobEvent) => void,
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
      const timer = setTimeout(stop, job.deadlineMs);
      signal.addEventListener("abort", stop, { once: true });
      worker.onmessage = (message: MessageEvent<FetchMessage>) => {
        if (message.data.type === "event") onEvent(message.data.event);
        else finish(message.data.result);
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
