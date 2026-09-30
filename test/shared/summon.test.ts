// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  noAgentNamed,
  readSummon,
  summonWord,
} from "../../src/shared/summon.ts";

const agents = new Set(["coder", "checker", "glm"]);
const read = (text: string) =>
  readSummon(text, "coder", (name) => agents.has(name));

describe("summon", () => {
  test("the first word names the agent, the rest is the ask", () => {
    expect(read("@glm check this")).toEqual({ kind: "summon", name: "glm" });
    expect(read("  @checker\nnext line")).toEqual({
      kind: "summon",
      name: "checker",
    });
  });

  test("a name matches regardless of case", () => {
    expect(read("@GLM check")).toEqual({ kind: "summon", name: "glm" });
  });

  test("punctuation ending the word is not part of the name", () => {
    expect(read("@glm, check")).toEqual({ kind: "summon", name: "glm" });
    expect(read("@Glm: check")).toEqual({ kind: "summon", name: "glm" });
    expect(read("@coder, go on")).toEqual({ kind: "none" });
    expect(read("@, hi")).toEqual({ kind: "none" });
  });

  test("the chat's own agent is an ordinary turn", () => {
    expect(read("@coder go on")).toEqual({ kind: "none" });
    expect(read("@Coder go on")).toEqual({ kind: "none" });
  });

  test("a word naming no agent is unknown, as typed", () => {
    expect(read("@Glmm check")).toEqual({ kind: "unknown", word: "Glmm" });
    expect(read("@glmm, check")).toEqual({ kind: "unknown", word: "glmm," });
    expect(noAgentNamed("Glmm")).toBe("no agent named Glmm");
  });

  test("an @name past the first word, or a bare @, is plain text", () => {
    expect(read("ask @glm later")).toEqual({ kind: "none" });
    expect(read("@ glm")).toEqual({ kind: "none" });
    expect(read("")).toEqual({ kind: "none" });
    expect(summonWord("email me@example.com")).toBeNull();
  });
});
