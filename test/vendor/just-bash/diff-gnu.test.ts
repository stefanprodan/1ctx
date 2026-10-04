// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// diff against what GNU diffutils 3.12 answered for the same arguments,
// recorded by scripts/record/diff.ts. A case with `accept` pins our answer
// where we differ on purpose.

import { describe } from "bun:test";
import type { Fixture } from "../../../scripts/record/cases.ts";
import recorded from "../../fixtures/just-bash/diff-gnu.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

// Cases we still answer differently; a listed case that passes fails.
const KNOWN = new Set<string>([]);

describe("diff as GNU diffutils 3.12", () => {
  // diff's 1 is a difference and 2 trouble, which a script tells apart
  recordedCases("diff", recorded as Fixture, KNOWN, true);
});
