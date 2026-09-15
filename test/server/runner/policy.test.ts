// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Thinking and effort are fixed when a send begins, including provider
// defaults captured by the agent's catalog row.

import { describe, expect, test } from "bun:test";
import type { AgentRow } from "../../../src/server/agents/index.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  buildPolicy,
  type SendPolicy,
} from "../../../src/server/runner/policy.ts";
import type { UserRow } from "../../../src/server/users/index.ts";

const user: UserRow = {
  id: "u1",
  username: "ana",
  fullName: "Ana",
  email: "ana@example.com",
  tz: "UTC",
  about: "",
  role: "member",
  passwordHash: "hash",
  createdAt: 1,
  disabled: false,
  mustChangePassword: false,
};

const agent: AgentRow = {
  id: "a1",
  name: "coder",
  avatar: "bot",
  providerId: "p1",
  model: {
    id: "org/model",
    name: "Model",
    contextLength: 1000,
    promptPrice: null,
    completionPrice: null,
    tools: false,
    reasoning: true,
  },
  thinking: null,
  effort: "high",
  prompt: "",
  skills: [],
  createdAt: 1,
};

function policy(
  changes: Partial<Pick<AgentRow, "thinking" | "effort">> & {
    reasoning?: boolean;
  },
): SendPolicy {
  return buildPolicy({
    project: { id: "project", kind: "team", name: "ops", description: "" },
    user,
    agent: {
      ...agent,
      ...changes,
      model: {
        ...agent.model,
        reasoning: changes.reasoning ?? agent.model.reasoning,
      },
    },
    now: 1,
    tools: null,
    limits: DEFAULT_LIMITS,
  });
}

describe("send policy thinking", () => {
  test("copies the compaction limits onto the send", () => {
    expect(policy({}).limits).toMatchObject({
      contextReserve: 20_000,
      summaryMaxTokens: 4096,
    });
  });

  test("null follows the catalog reasoning flag both ways", () => {
    expect(policy({ reasoning: true })).toMatchObject({
      thinking: true,
      effort: "high",
    });
    expect(policy({ reasoning: false })).toMatchObject({
      thinking: false,
      effort: null,
    });
  });

  test("on overrides a non-reasoning model", () => {
    expect(policy({ thinking: "on", reasoning: false })).toMatchObject({
      thinking: true,
      effort: "high",
    });
  });

  test("off overrides a reasoning model and drops effort", () => {
    expect(policy({ thinking: "off", reasoning: true })).toMatchObject({
      thinking: false,
      effort: null,
    });
  });
});
