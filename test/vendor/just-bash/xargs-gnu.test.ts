// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// xargs against what GNU xargs 4.11.0 answered for the same arguments,
// recorded by scripts/xargs-record.ts. A case with `accept` pins our
// answer where we differ on purpose.

import { describe } from "bun:test";
import type { Fixture } from "../../../scripts/record-cases.ts";
import recorded from "../../fixtures/just-bash/xargs-gnu.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

// Cases we still answer differently; a listed case that passes fails.
const KNOWN = new Set<string>([]);

describe("xargs as GNU xargs 4.11.0", () => {
  // 123 to 127 each say what went wrong, which a script tells apart
  recordedCases("xargs", recorded as Fixture, KNOWN, true);
});
