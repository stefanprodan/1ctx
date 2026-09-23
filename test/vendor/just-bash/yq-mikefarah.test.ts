// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// yq against what mikefarah's yq v4.53.3 answered for the same arguments,
// recorded by scripts/yq-record.ts. A case with `accept` pins our answer
// where we differ on purpose.

import { describe } from "bun:test";
import type { Fixture } from "../../../scripts/record-cases.ts";
import recorded from "../../fixtures/just-bash/yq-mikefarah.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

describe("yq as mikefarah's", () => {
  recordedCases("yq", recorded as Fixture);
});
