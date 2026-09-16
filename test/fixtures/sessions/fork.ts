// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  Message,
  SendSummary,
} from "../../../src/shared/contracts/session.ts";

export type ForkSend = Pick<SendSummary, "id" | "kind" | "memoryRound">;

type ForkFixture = {
  name: string;
  rows: Partial<Message>[];
  sends?: ForkSend[];
  target: string;
  ids?: string[];
  draft?: string;
  error?: { status: number; message: string };
};

const user: Partial<Message> = {
  id: "user",
  seq: 1,
  kind: "user",
  slot: null,
  content: "  edit this\nsecond line  ",
};
const answer: Partial<Message> = { id: "answer", seq: 2 };
const summary: Partial<Message> = {
  id: "summary",
  seq: 3,
  round: 2,
  kind: "summary",
  slot: null,
};
const compact: Partial<Message> = {
  ...summary,
  id: "compact-summary",
  seq: 4,
  round: 1,
  sendId: "compact",
};
const laterUser: Partial<Message> = {
  ...user,
  id: "later-user",
  seq: 5,
  sendId: "later",
  content: "next question",
};
const notTurn = { status: 400, message: "not a turn" };

export const forkSends: ForkSend[] = [
  { id: "send", kind: "chat", memoryRound: null },
  { id: "compact", kind: "compact", memoryRound: null },
  { id: "later", kind: "chat", memoryRound: null },
];

export function forkRow(fields: Partial<Message>): Message {
  return {
    id: "answer",
    sessionId: "session",
    seq: 2,
    kind: "reply",
    sendId: "send",
    round: 1,
    slot: "answer",
    userId: fields.kind === "user" ? "user-id" : null,
    agentId: fields.kind === "user" ? null : "agent-id",
    content: "the answer",
    resultBytes: null,
    promptTokens: null,
    reasoning: "",
    html: "",
    status: "done",
    error: null,
    finishReason: "stop",
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    model: "model",
    ttftMs: null,
    thinkingMs: null,
    createdAt: 10,
    finishedAt: 20,
    ...fields,
  };
}

export const forkFixtures: ForkFixture[] = [
  {
    name: "an answer keeps its own done summary",
    rows: [user, answer, summary, laterUser],
    target: "answer",
    ids: ["user", "answer", "summary"],
  },
  {
    name: "an answer keeps directly following compact summaries",
    rows: [user, answer, summary, compact, laterUser],
    target: "answer",
    ids: ["user", "answer", "summary", "compact-summary"],
  },
  {
    name: "a compact summary need not follow an automatic summary",
    rows: [user, answer, compact, laterUser],
    target: "answer",
    ids: ["user", "answer", "compact-summary"],
  },
  {
    name: "sequence order decides the cut without sorting the input in place",
    rows: [laterUser, compact, user, summary, answer],
    target: "answer",
    ids: ["user", "answer", "summary", "compact-summary"],
  },
  {
    name: "the first user message leaves an empty chat and its exact draft",
    rows: [user, answer],
    target: "user",
    ids: [],
    draft: "  edit this\nsecond line  ",
  },
  {
    name: "a later user message excludes itself and its unfinished reply",
    rows: [
      user,
      answer,
      summary,
      compact,
      laterUser,
      { id: "streaming", seq: 6, sendId: "later", status: "streaming" },
    ],
    target: "later-user",
    ids: ["user", "answer", "summary", "compact-summary"],
    draft: "next question",
  },
  {
    name: "a stopped answer is a settled turn",
    rows: [user, { ...answer, status: "stopped" }, compact],
    target: "answer",
    ids: ["user", "answer", "compact-summary"],
  },
  {
    name: "a summary from another chat send is not part of the answer",
    rows: [user, answer, { ...summary, sendId: "later" }],
    target: "answer",
    ids: ["user", "answer"],
  },
  ...(["failed", "stopped", "streaming"] as const).map((status) => ({
    name: `a ${status} summary ends the contiguous summary tail`,
    rows: [user, answer, { ...summary, status }, compact],
    target: "answer",
    ids: ["user", "answer"],
  })),
  {
    name: "a work row interrupts the summary tail",
    rows: [
      user,
      answer,
      { id: "work", seq: 3, round: 2, slot: "work" },
      compact,
    ],
    target: "answer",
    ids: ["user", "answer"],
  },
  {
    name: "a run answer never takes its following memory phase",
    rows: [
      user,
      answer,
      summary,
      { id: "memory-work", seq: 4, round: 3, slot: "work" },
    ],
    sends: [{ id: "send", kind: "run", memoryRound: 2 }],
    target: "answer",
    ids: ["user", "answer"],
  },
  {
    name: "a later user cut removes every earlier memory phase row",
    rows: [
      user,
      answer,
      { id: "memory-work", seq: 3, round: 2, slot: "work" },
      { id: "memory-tool", seq: 4, round: 2, kind: "tool", slot: null },
      laterUser,
    ],
    sends: [
      { id: "send", kind: "run", memoryRound: 2 },
      { id: "later", kind: "chat", memoryRound: null },
    ],
    target: "later-user",
    ids: ["user", "answer"],
    draft: "next question",
  },
  {
    name: "a done summary at the memory boundary is not a compact tail",
    rows: [user, answer, compact],
    sends: [
      { id: "send", kind: "chat", memoryRound: null },
      { id: "compact", kind: "compact", memoryRound: 1 },
    ],
    target: "answer",
    ids: ["user", "answer"],
  },
  {
    name: "a missing message is a 404",
    rows: [user, answer],
    target: "missing",
    error: { status: 404, message: "no such message" },
  },
  {
    name: "an empty history has no fork point",
    rows: [],
    target: "answer",
    error: { status: 404, message: "no such message" },
  },
  ...(["tool", "summary"] as const).map((kind) => ({
    name: `a ${kind} is not a turn`,
    rows: [user, { ...answer, kind, slot: null }],
    target: "answer",
    error: notTurn,
  })),
  ...(["failed", "streaming"] as const).map((status) => ({
    name: `a ${status} answer is not a settled turn`,
    rows: [user, { ...answer, status }],
    target: "answer",
    error: notTurn,
  })),
  ...(["failed", "stopped", "streaming"] as const).map((status) => ({
    name: `a ${status} user message is not a settled turn`,
    rows: [{ ...user, status }, answer],
    target: "user",
    error: notTurn,
  })),
  ...(["work", null] as const).map((slot) => ({
    name: `a reply with slot ${slot} is not an answer`,
    rows: [user, { ...answer, slot }],
    target: "answer",
    error: notTurn,
  })),
  ...([2, 3] as const).map((round) => ({
    name: `an answer at memory round ${round} is not a turn`,
    rows: [user, { ...answer, round }],
    sends: [{ id: "send", kind: "run" as const, memoryRound: 2 }],
    target: "answer",
    error: notTurn,
  })),
  {
    name: "a user row at the memory boundary is not a turn",
    rows: [user, answer],
    sends: [{ id: "send", kind: "run", memoryRound: 1 }],
    target: "user",
    error: notTurn,
  },
];
