// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records what GNU bash and coreutils answer for short scripts into the
// fixture the shell tests compare against: `bun scripts/bash-record.ts`,
// with bash 5 first on the PATH and GNU coreutils behind it. Each case is
// `bash -c SCRIPT` in a fresh folder; the tree it leaves is kept.

import { record } from "./record-cases.ts";

await record(
  "bash",
  new URL("../test/fixtures/just-bash/bash-gnu.json", import.meta.url).pathname,
  /GNU bash, version 5\./,
  { nullStdin: true },
);
