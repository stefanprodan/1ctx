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
    described: true,
  },
  thinking: null,
  effort: "high",
  prompt: "",
  skills: [],
  servers: [],
  mcpMode: "auto",
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
    knowledge: { files: 0, recent: [] },
    limits: DEFAULT_LIMITS,
  });
}

describe("send policy thinking", () => {
  test("copies the disabled set even when the model takes no tools", () => {
    const disabledCapabilities = ["web"];
    const send = buildPolicy({
      project: { id: "project", kind: "team", name: "ops", description: "" },
      user,
      agent,
      now: 1,
      tools: null,
      disabledCapabilities,
      knowledge: { files: 0, recent: [] },
      limits: DEFAULT_LIMITS,
    });
    disabledCapabilities.length = 0;
    expect(send.disabledCapabilities).toEqual(["web"]);
    expect(send.web).toBeNull();
    expect(send.offered.web).toBeNull();
    expect(send.offered.tools).toEqual([]);
  });

  test("copies automation guidance instead of keeping the caller's object", () => {
    const automation: NonNullable<SendPolicy["automation"]> = {
      id: "automation",
      name: "nightly",
      source: "manual",
      dueAt: 1,
      tz: "UTC",
      projectMemory: false,
      ownMemory: true,
      memoryGuidance: "Sources: failed hosts",
    };
    const send = buildPolicy({
      project: { id: "project", kind: "team", name: "ops", description: "" },
      user,
      agent,
      now: 1,
      tools: null,
      knowledge: { files: 0, recent: [] },
      limits: DEFAULT_LIMITS,
      automation,
    });
    automation.memoryGuidance = "Snapshot: latest result";
    expect(send.automation?.memoryGuidance).toBe("Sources: failed hosts");
  });

  test("copies the compaction limits onto the send", () => {
    expect(policy({}).limits).toMatchObject({
      contextReserve: 20_000,
      summaryMaxTokens: 4096,
    });
  });

  test("snapshots the tool-work and bash limits separately from later changes", () => {
    const limits = {
      ...DEFAULT_LIMITS,
      rounds: 250,
      toolWorkTokens: 750_000,
      maxBashCalls: 200,
    };
    const send = buildPolicy({
      project: { id: "project", kind: "team", name: "ops", description: "" },
      user,
      agent,
      now: 1,
      tools: null,
      knowledge: { files: 0, recent: [] },
      limits,
    });
    limits.rounds = 20;
    limits.toolWorkTokens = 50_000;
    limits.maxBashCalls = 10;
    expect(send.limits).toMatchObject({
      rounds: 250,
      toolWorkTokens: 750_000,
    });
    expect(send.toolCaps.maxBashCalls).toBe(200);
    expect(send.limits).not.toHaveProperty("maxBashCalls");
    expect(send.toolCaps).not.toHaveProperty("toolWorkTokens");
  });

  test("copies the knowledge count and recent files without tools", () => {
    const knowledge = {
      files: 1,
      recent: [{ name: "docs/x.md", author: "coder", updatedAt: 1 }],
    };
    const send = buildPolicy({
      project: { id: "project", kind: "team", name: "ops", description: "" },
      user,
      agent,
      now: 1,
      tools: null,
      limits: DEFAULT_LIMITS,
      knowledge,
    });
    knowledge.files = 2;
    knowledge.recent[0]!.name = "changed.md";
    knowledge.recent.push({ name: "new.md", author: "ana", updatedAt: 2 });
    expect(send.knowledge).toEqual({
      files: 1,
      recent: [{ name: "docs/x.md", author: "coder", updatedAt: 1 }],
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
