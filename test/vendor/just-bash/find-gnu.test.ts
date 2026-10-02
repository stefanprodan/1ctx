// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// find against what GNU find 4.11.0 answered for the same arguments,
// recorded by scripts/find-record.ts, its stderr and the tree it left
// included. A case with `accept` pins our answer where we differ on purpose.

import { describe } from "bun:test";
import type { Fixture } from "../../../scripts/record-cases.ts";
import recorded from "../../fixtures/just-bash/find-gnu.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

// Cases we still answer differently; a listed case that passes fails.
const KNOWN = new Set<string>([]);

describe("find as GNU find 4.11.0", () => {
  recordedCases("find", recorded as Fixture, KNOWN, true);
});
