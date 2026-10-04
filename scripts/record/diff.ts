// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records GNU diffutils 3.12's answers into the fixture the diff tests
// compare against: `bun scripts/record/diff.ts`, with Homebrew's diffutils
// first on the PATH as `diff`. Apple's /usr/bin/diff is refused.

import { record } from "./cases.ts";

await record(
  "diff",
  new URL("../../test/fixtures/just-bash/diff-gnu.json", import.meta.url)
    .pathname,
  /\(GNU diffutils\) 3\.12\b/,
);
