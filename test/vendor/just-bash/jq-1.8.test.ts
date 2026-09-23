// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// jq against what jq 1.8 answered for the same arguments, recorded by
// scripts/jq-record.ts, on the engine rules the yq dialect work changed.
// A case with `accept` pins our answer where we differ on purpose.

import { describe } from "bun:test";
import type { Fixture } from "../../../scripts/record-cases.ts";
import recorded from "../../fixtures/just-bash/jq-1.8.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

describe("jq as jq 1.8", () => {
  recordedCases("jq", recorded as Fixture);
});
