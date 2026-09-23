// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records mikefarah's yq answers into the fixture the yq tests compare
// against: `bun scripts/yq-record.ts`, with yq v4 on the PATH.

import { record } from "./record-cases.ts";

await record(
  "yq",
  new URL("../test/fixtures/just-bash/yq-mikefarah.json", import.meta.url)
    .pathname,
  /mikefarah\/yq.* version v4\./,
);
