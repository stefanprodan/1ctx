// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// bun:sqlite is synchronous, so the reads run off the thread that
// serves the streams.

import { Database } from "bun:sqlite";
import { messageOf } from "../lib/errors.ts";
import {
  type MonthResult,
  month,
  type RangeInput,
  type RangeResult,
  range,
} from "./range.ts";
import { type ScanInput, type ScanResult, scan } from "./scan.ts";

declare var self: Worker;

export type Job =
  | { kind: "storage"; input: ScanInput }
  | { kind: "range"; input: RangeInput }
  | { kind: "month"; input: RangeInput };

export type WorkerRequest = { path: string; job: Job };
export type WorkerReply =
  | { ok: true; result: ScanResult | RangeResult | MonthResult }
  | { ok: false; error: string };

function run(db: Database, job: Job): ScanResult | RangeResult | MonthResult {
  if (job.kind === "storage") return scan(db, job.input);
  return job.kind === "range" ? range(db, job.input) : month(db, job.input);
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
      error: messageOf(error),
    };
  } finally {
    db?.close();
  }
  self.postMessage(reply);
};
