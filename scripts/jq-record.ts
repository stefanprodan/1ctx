// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records jq 1.8's answers into the fixture the jq tests compare against:
// `bun scripts/jq-record.ts`, with jq 1.8 on the PATH.

import { record } from "./record-cases.ts";

await record(
  "jq",
  new URL("../test/fixtures/just-bash/jq-1.8.json", import.meta.url).pathname,
  /^jq-1\.8\./,
);
