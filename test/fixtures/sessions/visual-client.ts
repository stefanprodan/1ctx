// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  Message,
  SessionDetail,
} from "../../../src/shared/contracts/session.ts";
import type { VisualFrame } from "../../../src/shared/socket.ts";

export function visualRow(fields: Partial<Message> = {}): Message {
  return {
    id: "reply0000001",
    sessionId: "session00001",
    sendId: "send00000001",
    seq: 2,
    round: 1,
    kind: "reply",
    slot: "work",
    userId: null,
    agentId: "agent0000001",
    content: "",
    reasoning: "",
    html: "",
    error: null,
    status: "streaming",
    finishReason: null,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    model: "test",
    resultBytes: null,
    uploads: null,
    promptTokens: null,
    ttftMs: null,
    thinkingMs: null,
    createdAt: 1,
    finishedAt: null,
    ...fields,
  };
}

export const visualCall = {
  id: "call1", name: "visualize",
  arguments: JSON.stringify({ title: "Diagram", html: 42 }),
};

export function visualDetail(): SessionDetail {
  return {
    session: {
      id: "session00001", projectId: "project00001", ownerId: "user00000001",
      agentId: "agent0000001", origin: "chat", forkedFromId: null,
      automationId: null, runSource: null, title: "Visual",
      status: "running", revision: 1, createdAt: 1, lastActivityAt: 1,
      disabledCapabilities: [],
      usage: null,
    },
    forkedFrom: null,
    messages: [visualRow()],
    send: {
      id: "send00000001", sessionId: "session00001", kind: "chat",
      userId: "user00000001", agentId: "agent0000001",
      providerId: "provider0001", model: "test", status: "running",
      cause: null, error: null, firstMessageId: "userrow00001",
      rounds: 1, toolCalls: 0, memoryRound: null, memoryError: null,
      memorySkipped: null, tokens: 0, startedAt: 1, finishedAt: null,
    },
    live: {
      phase: "reply", sendId: "send00000001", messageId: "reply0000001",
      seq: 0, content: "", reasoning: "", html: "", htmlAt: 0,
    },
  };
}

export function visualFrame(fields: Partial<VisualFrame> = {}): VisualFrame {
  return {
    type: "visual", sessionId: "session00001", sendId: "send00000001",
    messageId: "reply0000001", callIndex: 0, seq: 1,
    title: "Diagram", html: "<svg>", htmlAt: 0,
    ...fields,
  };
}

export const rejectedVisualReplies: unknown[] = [
  null, [], {}, { type: "connect" }, { type: "paint", html: "" },
  { type: "ready", extra: true }, { type: "height", height: "120" },
  { type: "height", height: NaN }, { type: "height", height: Infinity },
  { type: "height", height: 100, extra: true },
  { type: "error", message: "x".repeat(241) },
  { type: "error", message: "two\nlines" },
  { type: "finalized", extra: true },
];
