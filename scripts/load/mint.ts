// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cluster's mint step, in a pod beside the stopped server's volume:
// one login per user from a file of token hashes. The tokens never
// reach this pod; only the driver's Secret holds them.
//
//   bun mint.js DB HASHES_JSON

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { type Logins, mintLogins, unminted } from "./logins.ts";

const [db, file] = process.argv.slice(2);
if (!db || !file) {
  console.error("usage: mint.js DB HASHES_JSON");
  process.exit(2);
}
const hashes = JSON.parse(readFileSync(file, "utf8")) as Logins;
const handle = new Database(db);
try {
  handle.exec("pragma busy_timeout = 5000");
  const now = Date.now();
  const made = handle.transaction(() => mintLogins(handle, hashes, now))();
  const wrong = unminted(handle, hashes, now);
  if (wrong.length > 0) throw new Error(`not minted: ${wrong.join(", ")}`);
  console.log(`minted ${made} logins`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  handle.close();
}
