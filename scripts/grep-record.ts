// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records GNU grep 3.12's answers into the fixture the grep tests compare
// against: `bun scripts/grep-record.ts`, with Homebrew's GNU grep on the
// PATH as `ggrep`, or as `grep` where it is the system's.

import { record } from "./record-cases.ts";

await record(
  Bun.which("ggrep") ? "ggrep" : "grep",
  new URL("../test/fixtures/just-bash/grep-gnu.json", import.meta.url).pathname,
  /\(GNU grep\) 3\.12\b/,
);
