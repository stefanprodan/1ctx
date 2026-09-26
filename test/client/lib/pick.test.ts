// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { skipWords } from "../../../src/client/lib/pick.ts";
import type { KnowledgeUploadReason } from "../../../src/shared/contracts/knowledge.ts";

describe("skip words", () => {
  test("words every skip code without inserting a member name", () => {
    const words: [KnowledgeUploadReason, string][] = [
      ["not-regular", "not a regular file"],
      ["outside", "outside the folder"],
      ["no-letters", "no letters or digits"],
      ["too-long", "name too long"],
      ["bad-name", "bad name"],
      ["duplicate", "duplicate name"],
      ["too-big", "over the file limit"],
      ["not-text", "not text"],
      ["clash", "clashes with another"],
      ["clash-live", "clashes with a file"],
    ];
    for (const [reason, expected] of words) {
      expect(skipWords(reason)).toBe(expected);
    }
    expect(skipWords("upload-size")).toBe("over the 32 MB upload limit");
  });
});
