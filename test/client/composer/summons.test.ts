// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  summonFill,
  summonMatches,
  summonQuery,
} from "../../../src/client/composer/summons.ts";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";

const agent = (id: string, name: string): AgentSummary => ({
  id,
  name,
  avatar: "bot",
  providerId: "pr1",
  model: {
    id: "acme/small",
    name: "Small",
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    tools: false,
    reasoning: false,
    thinkingRequired: false,
    reasoningKnown: true,
    described: true,
  },
  thinking: null,
  effort: null,
  prompt: "",
  skills: [],
  servers: [],
  mcpMode: "auto",
  upstream: null,
  skip4Bit: false,
  subagents: false,
  default: false,
  createdAt: 0,
});

const AGENTS = [
  agent("a1", "gemini"),
  agent("a2", "glm"),
  agent("a3", "grok"),
  agent("a4", "writer"),
];
const names = (list: AgentSummary[]) => list.map((a) => a.name);

describe("the @ menu", () => {
  test("a lone @ word is a query, a sentence is not", () => {
    expect(summonQuery("@")).toBe("");
    expect(summonQuery("@Gl")).toBe("gl");
    expect(summonQuery("@glm check")).toBeNull();
    expect(summonQuery("glm")).toBeNull();
    expect(summonQuery(" @glm")).toBeNull();
    expect(summonQuery("")).toBeNull();
  });

  test("lists the agents the word starts, the chat's own left out", () => {
    expect(names(summonMatches("@", AGENTS, "a1"))).toEqual([
      "glm",
      "grok",
      "writer",
    ]);
    expect(names(summonMatches("@g", AGENTS, "a1"))).toEqual(["glm", "grok"]);
    expect(names(summonMatches("@GL", AGENTS, "a1"))).toEqual(["glm"]);
    expect(summonMatches("@gemini", AGENTS, "a1")).toEqual([]);
    expect(summonMatches("@x", AGENTS, "a1")).toEqual([]);
    expect(summonMatches("@glm ", AGENTS, "a1")).toEqual([]);
    expect(summonMatches("hi @glm", AGENTS, "a1")).toEqual([]);
  });

  test("a new chat and an unloaded list open no menu", () => {
    expect(summonMatches("@", AGENTS, null)).toEqual([]);
    expect(summonMatches("@", null, "a1")).toEqual([]);
  });

  test("a pick fills the name and a space for the ask", () => {
    expect(summonFill(AGENTS[1]!)).toBe("@glm ");
  });
});
