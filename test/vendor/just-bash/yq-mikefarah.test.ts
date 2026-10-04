// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// yq against what mikefarah's yq v4.53.3 answered for the same arguments,
// recorded by scripts/record/yq.ts. A case with `accept` pins our answer
// where we differ on purpose.

import { describe } from "bun:test";
import type { Fixture } from "../../../scripts/record/cases.ts";
import recorded from "../../fixtures/just-bash/yq-mikefarah.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

// Cases we still answer differently; a listed case that passes fails.
const KNOWN = new Set<string>([
  // mikefarah carries a key's head comment into the list of keys
  "every key under .. collected",
  // an edit through an alias is refused, where mikefarah edits the anchor
  'anchors: -i .other += ["d"]',
]);

describe("yq as mikefarah's", () => {
  recordedCases("yq", recorded as Fixture, KNOWN);
});
