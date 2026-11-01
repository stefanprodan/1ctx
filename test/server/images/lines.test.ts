// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One line per image, the same in a turn's history and in the tail a
// summary keeps.

import { expect, test } from "bun:test";
import {
  type ContextLookups,
  type RenderPolicy,
  userMessage,
} from "../../../src/server/runner/render.ts";
import { tailOf } from "../../../src/server/runner/tail.ts";
import { chatMarkdown } from "../../../src/server/sessions/markdown.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";
import {
  imageLine,
  type MessageImage,
  withImageLines,
} from "../../../src/shared/images.ts";

const shot: MessageImage = {
  id: "i1",
  name: "pods.png",
  mediaType: "image/png",
  width: 1536,
  height: 2048,
  freed: false,
};
const gone: MessageImage = { ...shot, id: "i2", name: "old.jpg", freed: true };

const row = (fields: Partial<Message> & Pick<Message, "id">): Message => ({
  sessionId: "s",
  seq: 1,
  kind: "user",
  sendId: "snd1",
  round: 1,
  slot: null,
  userId: "u1",
  agentId: null,
  content: "",
  uploads: null,
  files: null,
  saved: null,
  resultBytes: null,
  promptTokens: null,
  reasoning: "",
  html: "",
  status: "done",
  error: null,
  finishReason: null,
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  model: null,
  ttftMs: null,
  thinkingMs: null,
  upstream: null,
  servedModel: null,
  nativeFinish: null,
  createdAt: 0,
  finishedAt: null,
  ...fields,
});

const policy: RenderPolicy = {
  username: "casey",
  userId: "u1",
  providerId: "pr",
  model: "org/model",
  agentId: "a",
  summoned: null,
  offered: { mcp: [], skills: { block: "", skills: [] } },
};

const lookups: ContextLookups = {
  usernameOf: () => null,
  reasoningDetailsOf: () => null,
  turnsOf: () => new Map(),
};

test("an image's line names it and its size, and says when it was removed", () => {
  expect(imageLine(shot)).toBe("[image: pods.png, 1536x2048]");
  expect(imageLine(gone)).toBe("[image removed: old.jpg, 1536x2048]");
  expect(withImageLines("look", [shot, gone])).toBe(
    "look\n\n[image: pods.png, 1536x2048]\n[image removed: old.jpg, 1536x2048]",
  );
  expect(withImageLines("", [shot])).toBe("[image: pods.png, 1536x2048]");
  expect(withImageLines("look", undefined)).toBe("look");
});

test("the history and a summary's tail render the same lines", () => {
  const user = row({ id: "u", content: "look", images: [shot, gone] });
  const rows = [
    user,
    row({
      id: "r",
      seq: 2,
      kind: "reply",
      slot: "answer",
      userId: null,
      agentId: "a",
      content: "a pod is failing",
    }),
    row({
      id: "sum",
      seq: 3,
      kind: "summary",
      userId: null,
      round: 9,
      content: "## Goal",
    }),
  ];
  const content =
    "look\n\n[image: pods.png, 1536x2048]\n[image removed: old.jpg, 1536x2048]";
  expect(userMessage(user, policy, lookups)).toEqual({
    role: "user",
    content,
    name: "casey",
  });
  const tail = tailOf(rows, 2, 10_000, policy, lookups, new Map(), null);
  expect(tail.start).toBe(0);
  expect(tail.messages[0]).toEqual({ role: "user", content, name: "casey" });
});

test("the Markdown of a message of images alone holds its lines", () => {
  const text = chatMarkdown(
    "chat",
    [
      {
        id: "u",
        sendId: "snd1",
        round: 1,
        memoryRound: null,
        kind: "user",
        slot: null,
        status: "done",
        error: null,
        finishReason: null,
        nativeFinish: null,
        author: "casey",
        content: "",
        uploads: null,
        images: [shot],
        createdAt: 0,
        finishedAt: 0,
      },
    ],
    "UTC",
  );
  expect(text).toEndWith(
    "## @casey 1970-01-01 00:00\n\n\\[image: pods.png, 1536x2048\\]\n",
  );
});
