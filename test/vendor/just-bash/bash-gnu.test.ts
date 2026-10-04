// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Short scripts against what GNU bash 5.2 and coreutils 9.4 answered for
// them, recorded by scripts/record/bash.ts, the tree each left included.

import { describe } from "bun:test";
import type { Fixture } from "../../../scripts/record/cases.ts";
import recorded from "../../fixtures/just-bash/bash-gnu.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

// Cases we still answer differently; a listed case that passes fails.
const KNOWN = new Set<string>([]);

describe("scripts as GNU bash and coreutils", () => {
  recordedCases("bash", recorded as Fixture, KNOWN, true);
});
