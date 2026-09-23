// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The scan worker: one read-only connection to the file, one scan per
// message, the result or the failure posted back. bun:sqlite is
// synchronous, so this runs off the thread that serves the streams.

import { Database } from "bun:sqlite";
import { type ScanInput, scan } from "./scan.ts";

declare var self: Worker;

export type WorkerRequest = { path: string; input: ScanInput };
export type WorkerReply =
  | { ok: true; result: ReturnType<typeof scan> }
  | { ok: false; error: string };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { path, input } = event.data;
  let reply: WorkerReply;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true, strict: true });
    db.exec("pragma busy_timeout = 5000");
    reply = { ok: true, result: scan(db, input) };
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
