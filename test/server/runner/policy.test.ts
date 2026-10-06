// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Thinking and effort are fixed when a send begins, including provider
// defaults captured by the agent's catalog row.

import { describe, expect, test } from "bun:test";
import type { AgentRow } from "../../../src/server/agents/index.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { modelPrice } from "../../../src/server/providers/index.ts";
import models from "../../../src/server/providers/models.json" with {
  type: "json",
};
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
  emailPlaceholder: false,
  emailFromAgents: false,
  agentId: null,
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
    thinkingRequired: false,
    reasoningKnown: true,
    described: true,
  },
  thinking: null,
  effort: "high",
  prompt: "",
  skills: [],
  servers: [],
  mcpMode: "auto",
  upstream: null,
  skip4Bit: false,
  subagents: false,
  default: false,
  createdAt: 1,
};

function policy(
  changes: Partial<Pick<AgentRow, "thinking" | "effort">> & {
    reasoning?: boolean;
    reasoningKnown?: boolean;
    thinkingRequired?: boolean;
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
        reasoningKnown: changes.reasoningKnown ?? agent.model.reasoningKnown,
        thinkingRequired:
          changes.thinkingRequired ?? agent.model.thinkingRequired,
      },
    },
    now: 1,
    tools: null,
    knowledge: { empty: true },
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
      knowledge: { empty: true },
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
      ownMemory: true,
      memoryGuidance: "Sources: failed hosts",
      attentionMode: "agent",
      attentionGuidance: "",
    };
    const send = buildPolicy({
      project: { id: "project", kind: "team", name: "ops", description: "" },
      user,
      agent,
      now: 1,
      tools: null,
      knowledge: { empty: true },
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

  test("copies the subagent limits onto the send", () => {
    expect(policy({}).limits).toMatchObject({
      childrenAtOnce: 2,
      childrenPerSend: 4,
      childAnswerChars: 8000,
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
      knowledge: { empty: true },
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

  test("carries whether the knowledge base is empty without tools", () => {
    const send = buildPolicy({
      project: { id: "project", kind: "team", name: "ops", description: "" },
      user,
      agent,
      now: 1,
      tools: null,
      limits: DEFAULT_LIMITS,
      knowledge: { empty: false },
    });
    expect(send.knowledge).toEqual({ empty: false });
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

  test("on overrides a model whose catalog lists no capabilities", () => {
    expect(
      policy({ thinking: "on", reasoning: false, reasoningKnown: false }),
    ).toMatchObject({ thinking: true, effort: "high" });
  });

  test("a word the model cannot take is never sent", () => {
    expect(policy({ thinking: "on", reasoning: false })).toMatchObject({
      thinking: false,
      thinkingOff: false,
      effort: null,
    });
    expect(policy({ thinking: "off", reasoning: false })).toMatchObject({
      thinking: false,
      thinkingOff: false,
    });
    expect(
      policy({ thinking: "off", reasoning: true, thinkingRequired: true }),
    ).toMatchObject({ thinking: true, thinkingOff: false, effort: "high" });
  });

  test("off overrides a reasoning model and drops effort", () => {
    expect(policy({ thinking: "off", reasoning: true })).toMatchObject({
      thinking: false,
      effort: null,
    });
  });
});

describe("send policy upstream", () => {
  const routed = (wire: SendPolicy["wire"]) =>
    buildPolicy({
      project: { id: "project", kind: "team", name: "ops", description: "" },
      user,
      agent: {
        ...agent,
        upstream: "inference-net/fp4",
        skip4Bit: true,
      },
      wire,
      now: 1,
      tools: null,
      knowledge: { empty: true },
      limits: DEFAULT_LIMITS,
    });

  test("rides only on the OpenRouter wire", () => {
    expect(routed("openrouter").upstream).toBe("inference-net/fp4");
    expect(routed("openai-compatible").upstream).toBeNull();
    expect(routed(null).upstream).toBeNull();
  });

  test("the host filter rides only on the OpenRouter wire", () => {
    expect(routed("openrouter").skip4Bit).toBe(true);
    expect(routed("openai-compatible").skip4Bit).toBe(false);
    expect(routed(null).skip4Bit).toBe(false);
  });
});

describe("send policy price", () => {
  const priced = (wire: SendPolicy["wire"], listedAs?: string) =>
    buildPolicy({
      project: { id: "project", kind: "team", name: "ops", description: "" },
      user,
      agent: { ...agent, model: { ...agent.model, listedAs } },
      wire,
      now: 1,
      tools: null,
      knowledge: { empty: true },
      limits: DEFAULT_LIMITS,
    }).price;

  test("is the models.dev rates of the agent's listed model", () => {
    const id = Object.keys(models.providers.azure).find(
      (m) => modelPrice("azure", m) !== null,
    )!;
    expect(priced("azure", id)).toEqual(modelPrice("azure", id));
  });

  test("is null with no listed model, no wire or an OpenAI wire", () => {
    const id = Object.keys(models.providers.azure)[0]!;
    expect(priced("azure")).toBeNull();
    expect(priced(null, id)).toBeNull();
    expect(priced("openai-compatible", id)).toBeNull();
  });
});
