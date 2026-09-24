// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// grep against what GNU grep 3.12 answered for the same arguments,
// recorded by scripts/grep-record.ts. A case with `accept` pins our answer
// where we differ on purpose.

import { describe } from "bun:test";
import type { Fixture } from "../../../scripts/record-cases.ts";
import recorded from "../../fixtures/just-bash/grep-gnu.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

// Cases we still answer differently; a listed case that passes fails.
const KNOWN = new Set<string>([]);

describe("grep as GNU grep 3.12", () => {
  // grep's 1 is no match and 2 an error, which a script tells apart
  recordedCases("grep", recorded as Fixture, KNOWN, true);
});
