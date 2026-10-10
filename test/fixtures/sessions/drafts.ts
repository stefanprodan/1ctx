// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Task proposals as the session's detail carries them, and the rows of
// a turn whose automation calls made them.

import { AUTOMATION_DEFAULTS } from "../../../src/shared/automation-defaults.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import type { AutomationDraft } from "../../../src/shared/contracts/automation-draft.ts";
import type {
  Message,
  SessionDetail,
} from "../../../src/shared/contracts/session.ts";

const base = {
  sendId: "send-1",
  agentId: "agent-1",
  askedBy: { id: "u1", username: "casey" },
  decidedBy: null,
  decidedAt: null,
  createdAutomationId: null,
  runSessionId: null,
  createdAt: 1_000,
  expiresAt: 1_000 + 86_400_000,
} as const;

export function createDraft(
  changes: Partial<AutomationDraft> = {},
): AutomationDraft {
  return {
    ...base,
    id: "draft-1",
    messageId: "tool-1",
    automationId: null,
    state: "pending",
    action: "create",
    fields: {
      ...AUTOMATION_DEFAULTS,
      name: "daily-digest",
      instructions: "Read the feed.\nWrite a digest.",
      schedule: "0 9 * * *",
      tz: "Europe/Bucharest",
      once: false,
      agentId: "agent-1",
      disabledCapabilities: [],
    },
    ...changes,
  } as AutomationDraft;
}

export function taskDraft(
  action: "update" | "suspend" | "resume" | "run",
  changes: Partial<AutomationDraft> = {},
): AutomationDraft {
  return {
    ...base,
    id: `draft-${action}`,
    messageId: `tool-${action}`,
    automationId: "task-1",
    state: "pending",
    action,
    fields: {},
    ...changes,
  } as AutomationDraft;
}

export function row(
  changes: Partial<Message> & Pick<Message, "id" | "seq">,
): Message {
  return {
    sessionId: "chat-1",
    kind: "reply",
    sendId: "send-1",
    round: 1,
    slot: null,
    userId: null,
    agentId: "agent-1",
    content: "",
    resultBytes: null,
    uploads: null,
    files: null,
    saved: null,
    promptTokens: null,
    reasoning: "",
    html: "",
    status: "done",
    error: null,
    finishReason: null,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    model: "model",
    ttftMs: null,
    thinkingMs: null,
    upstream: null,
    servedModel: null,
    nativeFinish: null,
    createdAt: 1_000,
    finishedAt: 2_000,
    ...changes,
  };
}

// one work round of automation calls, each with its tool row; a call's
// args are the JSON the model sent
export function proposalRows(
  calls: { id: string; args: unknown; status?: Message["status"] }[],
  createdAt = 1_000,
): Message[] {
  return [
    row({ id: "user-1", seq: 1, kind: "user", userId: "u1", content: "go" }),
    row({
      id: "work-1",
      seq: 2,
      slot: "work",
      finishReason: "tool_calls",
      createdAt,
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: "automation",
        arguments: JSON.stringify(call.args),
      })),
    }),
    ...calls.map((call, index) =>
      row({
        id: `tool-${call.id}`,
        seq: 3 + index,
        kind: "tool",
        toolCallId: call.id,
        toolName: "automation",
        status: call.status ?? "done",
        createdAt,
      }),
    ),
  ];
}

export function task(changes: Partial<AutomationSummary> = {}) {
  return {
    id: "task-1",
    name: "nightly-check",
    instructions: "Check the queue.\nReport failures.",
    schedule: "0 2 * * *",
    tz: "UTC",
    once: false,
    ...changes,
  } as AutomationSummary;
}

export function detail(
  drafts: AutomationDraft[],
  changes: Partial<SessionDetail["session"]> = {},
): SessionDetail {
  return {
    session: {
      id: "chat-1",
      projectId: "p1",
      ownerId: "u1",
      agentId: "agent-1",
      origin: "chat",
      forkedFromId: null,
      automationId: null,
      runSource: null,
      title: "chat",
      status: "done",
      revision: 1,
      createdAt: 1,
      lastActivityAt: 1,
      usage: null,
      disabledCapabilities: [],
      archived: null,
      attention: null,
      attentionReason: null,
      attentionSource: null,
      attentionBy: null,
      ...changes,
    },
    messages: [],
    queued: [],
    live: null,
    authors: [],
    agents: [],
    forkedFrom: null,
    automationDrafts: drafts,
  } as unknown as SessionDetail;
}
