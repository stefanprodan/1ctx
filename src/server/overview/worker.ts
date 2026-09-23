// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The main thread's side of the scan worker: a worker per scan, ended
// when it answers, when the deadline passes, or by close() at shutdown,
// so a stuck scan never holds every later request on its promise. The
// worker file is an entry point of the compiled binary, where a URL
// resolves against the compile root, so compose.ts builds it and
// passes it in.

import type { ScanInput, ScanResult } from "./scan.ts";
import type { WorkerReply, WorkerRequest } from "./scan.worker.ts";

export const SCAN_DEADLINE_MS = 30_000;

export type Scanner = {
  scan(input: ScanInput): Promise<ScanResult>;
  close(): void;
};

export function workerScanner(
  path: string,
  worker: URL,
  deadlineMs = SCAN_DEADLINE_MS,
): Scanner {
  let current: {
    worker: Worker;
    timer: ReturnType<typeof setTimeout>;
    fail: (error: Error) => void;
  } | null = null;
  const end = () => {
    if (current === null) return;
    clearTimeout(current.timer);
    current.worker.terminate();
    current = null;
  };
  return {
    scan(input) {
      return new Promise<ScanResult>((resolve, reject) => {
        const running = new Worker(worker);
        const timer = setTimeout(() => {
          end();
          reject(new Error("scan timed out"));
        }, deadlineMs);
        current = { worker: running, timer, fail: reject };
        running.onmessage = (event: MessageEvent<WorkerReply>) => {
          end();
          if (event.data.ok) resolve(event.data.result);
          else reject(new Error(event.data.error));
        };
        running.onerror = (event) => {
          end();
          reject(new Error(event.message || "scan worker failed"));
        };
        const request: WorkerRequest = { path, input };
        running.postMessage(request);
      });
    },
    close() {
      current?.fail(new Error("scan closed"));
      end();
    },
  };
}
