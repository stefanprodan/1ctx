// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records GNU find 4.11.0's answers into the fixture the find tests compare
// against: `bun scripts/find-record.ts`, with GNU findutils' find first on
// the PATH, or named by FIND. It runs as `find`, so its messages say so.

import { record } from "./record-cases.ts";

await record(
  process.env.FIND ?? Bun.which("find") ?? "find",
  new URL("../test/fixtures/just-bash/find-gnu.json", import.meta.url).pathname,
  /\(GNU findutils\) 4\.11\.0\b/,
  { argv0: "find", nullStdin: true },
);
