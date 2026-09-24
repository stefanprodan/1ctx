// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// rg against what ripgrep 15.2.0 answered for the same arguments, piped and
// with --no-require-git in its config, recorded by scripts/rg-record.ts. A
// case with `accept` pins our answer where we differ on purpose.

import { describe } from "bun:test";
import type { Fixture } from "../../../scripts/record-cases.ts";
import recorded from "../../fixtures/just-bash/rg-ripgrep.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

// Cases we still answer differently; a listed case that passes fails.
const KNOWN = new Set<string>([]);

describe("rg as ripgrep 15.2.0", () => {
  // rg's 1 is no match and 2 an error, which a script tells apart
  recordedCases("rg", recorded as Fixture, KNOWN, true);
});
