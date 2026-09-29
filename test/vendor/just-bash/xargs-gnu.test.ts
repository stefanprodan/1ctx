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
const KNOWN = new Set<string>([
  "-s with its value apart",
  "-s with its value attached",
  "--max-chars with =",
  "--show-limits with no input",
  "-s 0",
  "-s negative",
  "a name with a space splits",
  "-L with only a blank line",
  "-E at the start runs once",
  "empty input runs once",
  "blank input runs once",
  "empty input under -d runs once",
  "empty input under -0 runs once",
  "no command and no input",
  "-s fits two items",
  "-s fits one item",
  "-s too small for any item",
  "an item too long runs the ones before",
  "-s smaller than the command",
  "-s smaller than the command with no input",
  "-s equal to the command with no input",
  "-s equal to the command with an item",
  "-s under -r smaller than the command",
  "-s with -n splits early",
  "-s with -x and -n",
  "-s with -x without -n",
  "-s with -L too long",
  "-s with -L2 too long",
  "-s with -L1 and a long item",
  "-s with -I too long",
  "-s with -I replaced twice",
  "-s with -I and a long command",
  "a list past 128 KiB runs twice",
  "a list past 128 KiB with echo",
  "a list past 128 KiB with -x and -n",
  "a list past 128 KiB with -n",
  "an item past 128 KiB",
  "-I with an item past 128 KiB",
  "-a with /dev/null",
  "--process-slot-var with one process",
  "--process-slot-var apart",
  "a command exiting 3",
  "a command exiting 1 carries on",
  "a failure in the middle carries on",
  "a command exiting 255 stops",
  "255 after a failure",
  "a command exiting 126",
  "a command exiting 127",
  "a command exiting 254",
  "a command killed",
  "a missing command with no input",
  "false",
  "-I with a failing command",
  "-P with a failing command",
  "-P with 255",
  "cat of a missing file",
]);

describe("xargs as GNU xargs 4.11.0", () => {
  // 123 to 127 each say what went wrong, which a script tells apart
  recordedCases("xargs", recorded as Fixture, KNOWN, true);
});
