// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The scan worker: one read-only connection to the file, one job per
// message, the storage scan or the overview's range, the result or the
// failure posted back. bun:sqlite is synchronous, so this runs off the
// thread that serves the streams.

import { Database } from "bun:sqlite";
import { type RangeInput, type RangeResult, range } from "./range.ts";
import { type ScanInput, type ScanResult, scan } from "./scan.ts";

declare var self: Worker;

export type Job =
  | { kind: "storage"; input: ScanInput }
  | { kind: "range"; input: RangeInput };

export type WorkerRequest = { path: string; job: Job };
export type WorkerReply =
  | { ok: true; result: ScanResult | RangeResult }
  | { ok: false; error: string };

function run(db: Database, job: Job): ScanResult | RangeResult {
  return job.kind === "storage" ? scan(db, job.input) : range(db, job.input);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { path, job } = event.data;
  let reply: WorkerReply;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true, strict: true });
    db.exec("pragma busy_timeout = 5000");
    reply = { ok: true, result: run(db, job) };
  } catch (error) {
    reply = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
  self.postMessage(reply);
};
