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
const KNOWN = new Set<string>([
  "stdin with filename",
  "stdin label",
  "context group separator",
  "context no group separator",
  "context with filename",
  "context byte offset",
  "only after equals",
  "byte offset",
  "byte offset only",
  "byte offset only utf",
  "byte offset utf",
  "byte offset numbers",
  "byte offset filename",
  "byte offset long",
  "byte offset minified",
  "byte offset crlf",
  "byte offset invert",
  "byte offset stdin",
  "binary text",
  "binary text long",
  "binary files text",
  "binary files without match",
  "binary files binary",
  "binary skip I",
  "binary skip I count",
  "binary after nul",
  "perl lookbehind",
  "perl lookbehind value",
  "perl lookbehind overlap",
  "perl lookahead",
  "perl lookahead word",
  "perl lookaround both",
  "perl h",
  "perl R",
  "perl minified",
  "long with filename",
  "y is ignore case",
  "with filename H",
  "H and h last wins",
  "h and H last wins",
  "color never",
  "colour auto",
  "color bare",
  "color always",
  "line buffered",
  "U binary noop",
  "binary noop long",
  "null after name",
  "null with lines",
  "null long",
  "null data",
  "null data count",
  "null data file",
  "initial tab",
  "initial tab long",
  "exclude from",
  "minified keep price",
  "minified byte offset only",
  "with filename count",
  "perl word unicode",
  "perl alpha unicode",
  "perl lookbehind count",
  "perl lookahead line",
]);

describe("grep as GNU grep 3.12", () => {
  recordedCases("grep", recorded as Fixture, KNOWN);
});
