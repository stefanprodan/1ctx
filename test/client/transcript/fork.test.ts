// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  forkChoices,
  opensUp,
} from "../../../src/client/transcript/Fork.model.ts";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";

function agent(id: string): AgentSummary {
  return {
    id,
    name: id,
    avatar: "bot",
    providerId: "p1",
    model: {
      id: `org/${id}`,
      name: id,
      contextLength: null,
      promptPrice: null,
      completionPrice: null,
      tools: true,
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
    createdAt: 0,
  };
}

describe("forkChoices", () => {
  test("lists the session's agent first and keeps the rest in order", () => {
    const rows = forkChoices([agent("a"), agent("b"), agent("c")], "b");
    expect(rows.map((a) => a.id)).toEqual(["b", "a", "c"]);
  });

  test("an agent no longer listed changes nothing", () => {
    const rows = forkChoices([agent("a"), agent("b")], "gone");
    expect(rows.map((a) => a.id)).toEqual(["a", "b"]);
  });

  test("no agent is the list as it is", () => {
    expect(forkChoices([agent("a")], null).map((a) => a.id)).toEqual(["a"]);
  });
});

describe("opensUp", () => {
  test("hangs under the button while the rows fit above the foot", () => {
    // three rows: 3 * 38 + 12 = 126
    expect(opensUp(500, 700, 3)).toBe(false);
    expect(opensUp(600, 700, 3)).toBe(true);
  });

  test("an empty list is one line", () => {
    expect(opensUp(650, 700, 0)).toBe(false);
    expect(opensUp(660, 700, 0)).toBe(true);
  });
});
