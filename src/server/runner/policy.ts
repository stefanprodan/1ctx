// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a send runs under, decided once before startSend.

import { mcpKey } from "../../shared/capabilities.ts";
import type { MemoryEntry } from "../../shared/contracts/memory.ts";
import { fixedThinking } from "../../shared/thinking.ts";
import type { WebSnapshot } from "../../shared/web.ts";
import {
  type AttentionMode,
  EFFORTS,
  type Effort,
  type EventSource,
  type ProjectKind,
  type Wire,
} from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import type { Limits, LoopLimits, SendCaps } from "../limits/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import {
  type ChatRequest,
  type ModelPrice,
  modelPrice,
  modelSource,
  type ToolCall,
} from "../providers/index.ts";
import type {
  MemoryScope,
  Offered,
  ToolCaps,
  ToolContext,
  ToolResult,
} from "../tools/index.ts";
import type { UserRow } from "../users/index.ts";

export type {
  KeepPort,
  Offered,
  SendRepos,
  ToolBudget,
  ToolCaps,
  ToolContext,
  ToolResult,
} from "../tools/index.ts";

// the tools capability, as the runner sees it: a snapshot taken once
// per send, and a run per call reading the snapshot's provider key. The
// port is the runner's own interface over the area's types; compose
// passes the tools area
export type ToolsPort = {
  serverNames(links: AgentRow["servers"]): string[];
  skillsOff(agentId: string, disabledCapabilities: readonly string[]): string[];
  offered(
    now: number,
    agentId: string,
    agentServers: AgentRow["servers"],
    mode: AgentRow["mcpMode"],
    scope: MemoryScope,
    disabledCapabilities?: readonly string[],
  ): Offered;
  run(offered: Offered, call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  toolName?(offered: Offered, call: ToolCall): string;
  // a closed name for the log, never the model's
  logName?(offered: Offered, call: ToolCall): string;
  normalize?(offered: Offered, calls: ToolCall[]): ToolCall[];
};

export type SendPolicy = {
  projectId: string;
  projectName: string;
  projectKind: ProjectKind;
  projectDescription: string;
  userId: string;
  username: string;
  fullName: string;
  about: string;
  // the user's zone, so the model asks the datetime tool in it
  tz: string;
  agentId: string;
  agentName: string;
  // the chat's own agent when this agent was summoned for the turn, null
  // for the chat's own turns and a run
  summoned: string | null;
  providerId: string;
  providerName: string;
  // the provider's wire, null when its row is gone; the answer round's
  // retries depend on whether a local server caches the conversation
  wire: Wire | null;
  model: string;
  contextLength: number | null;
  // the models.dev rates of the agent's model, null when none price it;
  // a round whose reply has no cost is priced by them
  price: ModelPrice | null;
  prompt: string;
  thinking: boolean;
  // the agent's own Off, not a default that resolved to off
  thinkingOff: boolean;
  // the model always thinks, so no request turns it off
  thinkingRequired: boolean;
  effort: Effort | null;
  // the OpenRouter endpoint tag the agent prefers, null to let it route
  upstream: string | null;
  // leave out OpenRouter's 4-bit hosts; false on every other wire
  skip4Bit: boolean;
  // the snapshot the send runs under, its tools the schemas on the wire
  offered: Offered;
  disabledCapabilities: string[];
  mcpOff: string[];
  skillsOff: string[];
  web: WebSnapshot | null;
  memoryOffered: Offered | null;
  // the attention step's set, needs_attention alone, for a run whose
  // automation is not off on a model that takes tools
  attentionOffered: Offered | null;
  // a subagent's set, taken with the send's, when it offers delegate
  childOffered?: Offered | null;
  // a subagent's own send: its system prompt is subagentPrompt()
  subagent?: boolean;
  projectMemory: MemoryEntry[];
  automationMemory: MemoryEntry[];
  knowledge: { empty: boolean };
  automation: {
    id: string;
    name: string;
    source: EventSource;
    dueAt: number;
    tz: string;
    ownMemory: boolean;
    memoryGuidance: string;
    // who marks the run, and the automation's words on when
    attentionMode: AttentionMode;
    attentionGuidance: string;
  } | null;
  deadlineMs: number | null;
  // the caps the send started on, the limits area's word at that moment
  limits: LoopLimits;
  toolCaps: ToolCaps;
  // what admission holds the send to, read in the same turn
  sendCaps: SendCaps;
};

export const offers = (offered: Pick<Offered, "tools">, name: string) =>
  offered.tools.some((tool) => tool.name === name);

// no thinking, or the least effort the wire names for a model that
// always thinks: for a round that only needs a short answer or a call
export const leastThinking = (
  policy: Pick<SendPolicy, "thinkingRequired" | "thinkingOff" | "wire">,
): Pick<
  ChatRequest,
  "thinking" | "thinkingOff" | "least" | "reasoningEffort"
> => ({
  thinking: policy.thinkingRequired,
  thinkingOff: policy.thinkingOff,
  least: true,
  reasoningEffort:
    policy.thinkingRequired && policy.wire !== null
      ? EFFORTS[policy.wire][0]
      : null,
});

const NONE: Offered = {
  tools: [],
  visuals: false,
  knowledge: false,
  search: null,
  skills: { block: "", skills: [] },
  mcp: [],
  mcpPrompt: { text: "", digest: {} },
  mcpCatalog: "",
  memory: null,
  credentials: [],
  credentialsOff: [],
  web: null,
};

const priceOf = (wire: Wire | null, listedAs: string | undefined) => {
  const source = wire === null ? null : modelSource(wire);
  return source === null || listedAs === undefined
    ? null
    : modelPrice(source, listedAs);
};

export function buildPolicy(input: {
  project: Pick<ProjectRow, "id" | "kind" | "name" | "description">;
  user: UserRow;
  agent: AgentRow;
  providerName?: string;
  wire?: Wire | null;
  now: number;
  // the tools area, or none when the model does not accept tools; the
  // one place the set is decided
  tools: ToolsPort | null;
  disabledCapabilities?: readonly string[];
  limits: Limits;
  knowledge: SendPolicy["knowledge"];
  automation?: SendPolicy["automation"];
  // the chat a message or a regenerate saves from; a compaction offers
  // no tools and a run saves nothing
  sessionId?: string | null;
  projectMemory?: readonly MemoryEntry[];
  automationMemory?: readonly MemoryEntry[];
  deadlineMs?: number | null;
  summoned?: string | null;
}): SendPolicy {
  const { user, agent } = input;
  // a model that does not accept tools is offered none
  const tools = agent.model.tools ? input.tools : null;
  const disabledCapabilities = [...(input.disabledCapabilities ?? [])];
  const automationScope =
    input.automation === undefined || input.automation === null
      ? null
      : {
          id: input.automation.id,
          ownMemory: input.automation.ownMemory,
          attention:
            input.automation.attentionMode === "off"
              ? null
              : { guidance: input.automation.attentionGuidance },
        };
  const offered =
    tools !== null
      ? tools.offered(
          input.now,
          agent.id,
          agent.servers,
          agent.mcpMode,
          {
            projectId: input.project.id,
            automation: automationScope,
            phase: "main",
            chat:
              automationScope === null && input.sessionId
                ? { sessionId: input.sessionId, userId: user.id }
                : null,
            delegate: agent.subagents,
          },
          disabledCapabilities,
        )
      : NONE;
  const childOffered =
    tools !== null && agent.subagents
      ? tools.offered(
          input.now,
          agent.id,
          agent.servers,
          agent.mcpMode,
          { projectId: input.project.id, automation: null, phase: "child" },
          disabledCapabilities,
        )
      : null;
  const memoryOffered =
    tools !== null && automationScope?.ownMemory
      ? tools.offered(input.now, agent.id, agent.servers, agent.mcpMode, {
          projectId: input.project.id,
          automation: automationScope,
          phase: "memory",
        })
      : null;
  const attentionOffered =
    tools !== null && automationScope?.attention
      ? tools.offered(input.now, agent.id, [], "auto", {
          projectId: input.project.id,
          automation: automationScope,
          phase: "attention",
        })
      : null;
  // a word the model cannot take, saved before the catalog said so, is
  // never sent
  const fixed = fixedThinking(agent.model);
  const word = fixed ?? agent.thinking;
  const thinking = word === null ? agent.model.reasoning : word === "on";
  return {
    projectId: input.project.id,
    projectName: input.project.name,
    projectKind: input.project.kind,
    projectDescription: input.project.description,
    userId: user.id,
    username: user.username,
    fullName: user.fullName,
    about: user.about,
    tz: user.tz,
    agentId: agent.id,
    agentName: agent.name,
    summoned: input.summoned ?? null,
    providerId: agent.providerId,
    providerName: input.providerName ?? "",
    wire: input.wire ?? null,
    price: priceOf(input.wire ?? null, agent.model.listedAs),
    model: agent.model.id,
    contextLength: agent.model.contextLength,
    prompt: agent.prompt,
    thinking,
    thinkingOff: fixed === null && agent.thinking === "off",
    thinkingRequired: agent.model.thinkingRequired,
    effort: thinking ? agent.effort : null,
    upstream: input.wire === "openrouter" ? agent.upstream : null,
    skip4Bit: input.wire === "openrouter" && agent.skip4Bit,
    offered,
    disabledCapabilities,
    mcpOff:
      tools !== null
        ? tools
            .serverNames(
              agent.servers.filter((link) =>
                disabledCapabilities.includes(mcpKey(link.serverId)),
              ),
            )
            .sort()
        : [],
    skillsOff:
      tools !== null
        ? tools.skillsOff(agent.id, disabledCapabilities).sort()
        : [],
    web: offered.web,
    memoryOffered,
    attentionOffered,
    childOffered,
    projectMemory: (input.projectMemory ?? []).map((entry) => ({ ...entry })),
    automationMemory: (input.automationMemory ?? []).map((entry) => ({
      ...entry,
    })),
    knowledge: { empty: input.knowledge.empty },
    automation: input.automation ? { ...input.automation } : null,
    deadlineMs: input.deadlineMs ?? null,
    limits: {
      rounds: input.limits.rounds,
      callsPerRound: input.limits.callsPerRound,
      callsPerSend: input.limits.callsPerSend,
      toolMs: input.limits.toolMs,
      resultBytes: input.limits.resultBytes,
      toolWorkTokens: input.limits.toolWorkTokens,
      contextReserve: input.limits.contextReserve,
      summaryMaxTokens: input.limits.summaryMaxTokens,
      memoryPhaseMs: input.limits.memoryPhaseMs,
      memoryPhaseRounds: input.limits.memoryPhaseRounds,
      childrenAtOnce: input.limits.childrenAtOnce,
      childrenPerSend: input.limits.childrenPerSend,
      childAnswerChars: input.limits.childAnswerChars,
    },
    toolCaps: {
      callTimeoutMs: input.limits.callTimeoutMs,
      resultCut: input.limits.resultCut,
      maxBashCalls: input.limits.maxBashCalls,
      maxFetches: input.limits.maxFetches,
      maxSearches: input.limits.maxSearches,
      fetchBodyBytes: input.limits.fetchBodyBytes,
      searchBodyBytes: input.limits.searchBodyBytes,
      fetchDeadlineMs: input.limits.fetchDeadlineMs,
      searchDeadlineMs: input.limits.searchDeadlineMs,
      visualBytes: input.limits.visualBytes,
      visualSendBytes: input.limits.visualSendBytes,
      maxVisuals: input.limits.maxVisuals,
    },
    sendCaps: {
      sendsPerUser: input.limits.sendsPerUser,
      sendsPerProject: input.limits.sendsPerProject,
      sendsRunning: input.limits.sendsRunning,
    },
  };
}
