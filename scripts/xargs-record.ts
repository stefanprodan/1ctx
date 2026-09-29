// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records GNU xargs 4.11.0's answers into the fixture the xargs tests
// compare against: `bun scripts/xargs-record.ts`, with Homebrew's
// findutils installed. Its gnubin goes first on the PATH, so the binary
// and its words say `xargs`; Apple's xargs is refused by the version.

import { record } from "./record-cases.ts";

const GNUBIN = "/opt/homebrew/opt/findutils/libexec/gnubin";
process.env.PATH = `${GNUBIN}:${process.env.PATH ?? ""}`;

await record(
  // spawn resolves a bare name on the PATH it started with
  Bun.which("xargs", { PATH: process.env.PATH }) ?? "xargs",
  new URL("../test/fixtures/just-bash/xargs-gnu.json", import.meta.url)
    .pathname,
  /\(GNU findutils\) 4\.11\.0\b/,
);
