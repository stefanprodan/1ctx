// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The main thread's side of the scan worker: a worker per job, ended
// when it answers, when the deadline passes, or by close() at shutdown,
// so a stuck job never holds every later request on its promise. A
// storage scan and a range read may be in flight together, each on its
// own worker. The worker file is an entry point of the compiled
// binary, where a URL resolves against the compile root, so compose.ts
// builds it and passes it in.

import type { RangeInput, RangeResult } from "./range.ts";
import type { ScanInput, ScanResult } from "./scan.ts";
import type { Job, WorkerReply, WorkerRequest } from "./scan.worker.ts";

export const SCAN_DEADLINE_MS = 30_000;

export type Scanner = {
  scan(input: ScanInput): Promise<ScanResult>;
  range(input: RangeInput): Promise<RangeResult>;
  close(): void;
};

type Running = {
  worker: Worker;
  timer: ReturnType<typeof setTimeout>;
  fail: (error: Error) => void;
};

export function workerScanner(
  path: string,
  worker: URL,
  deadlineMs = SCAN_DEADLINE_MS,
): Scanner {
  const running = new Set<Running>();
  const end = (job: Running) => {
    if (!running.delete(job)) return;
    clearTimeout(job.timer);
    job.worker.terminate();
  };
  function post<T>(job: Job): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const started = new Worker(worker);
      const timer = setTimeout(() => {
        end(entry);
        reject(new Error("scan timed out"));
      }, deadlineMs);
      const entry: Running = { worker: started, timer, fail: reject };
      running.add(entry);
      started.onmessage = (event: MessageEvent<WorkerReply>) => {
        end(entry);
        if (event.data.ok) resolve(event.data.result as T);
        else reject(new Error(event.data.error));
      };
      started.onerror = (event) => {
        end(entry);
        reject(new Error(event.message || "scan worker failed"));
      };
      const request: WorkerRequest = { path, job };
      started.postMessage(request);
    });
  }
  return {
    scan: (input) => post<ScanResult>({ kind: "storage", input }),
    range: (input) => post<RangeResult>({ kind: "range", input }),
    close() {
      for (const job of [...running]) {
        job.fail(new Error("scan closed"));
        end(job);
      }
    },
  };
}
