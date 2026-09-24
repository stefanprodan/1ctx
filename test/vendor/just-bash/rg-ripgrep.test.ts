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
const KNOWN = new Set<string>([
  "vimgrep",
  "stdin vimgrep",
  "stdin dash heading",
  "stdin utf",
  "unrestricted thrice",
  "no require git",
  "require git",
  "field match separator vimgrep",
  "context heading",
  "type alias",
  "type add",
  "replace vimgrep",
  "replace multiline",
  "heading",
  "heading numbers",
  "heading one file",
  "no heading",
  "max columns",
  "max columns long",
  "max columns preview",
  "max columns short line",
  "max columns only",
  "trim",
  "encoding",
  "color never",
  "color never equals",
  "colors",
  "sort files",
  "sortr path",
  "crlf flag",
  "no messages",
  "null names",
  "null count",
  "path separator",
  "no ignore parent",
  "no config",
  "one file system",
  "line buffered",
  "engine default",
  "pcre2",
  "pcre2 long",
  "pcre2 lookbehind",
  "pcre2 backreference",
  "unicode word",
  "unicode word boundary",
  "word boundary",
  "vimgrep utf",
  "type list",
]);

describe("rg as ripgrep 15.2.0", () => {
  // rg's 1 is no match and 2 an error, which a script tells apart
  recordedCases("rg", recorded as Fixture, KNOWN, true);
});
