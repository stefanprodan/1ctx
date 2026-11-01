// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Images in a chat's history: the check at 32K, 200K and 1M windows,
// the set replayed between summaries, the tail and the summary round's
// fallback, on fixtures.

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  type ChatMessageIn,
  type ChatRequest,
  imagePartsOf,
  imageTokens,
  requestTokens,
} from "../../../src/server/providers/index.ts";
import {
  history,
  request,
  SUMMARY_LEAD,
  summaryRequest,
} from "../../../src/server/runner/context.ts";
import { unfitImages } from "../../../src/server/runner/image-fit.ts";
import type { Offered, SendPolicy } from "../../../src/server/runner/policy.ts";
import type { ContextLookups } from "../../../src/server/runner/render.ts";
import { buildRequest } from "../../../src/server/runner/round.ts";
import type { ActiveSend } from "../../../src/server/runner/send.ts";
import { compactsAt } from "../../../src/shared/compaction.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";
import {
  imagesFit,
  type MessageImage,
  NO_IMAGE_ROOM,
} from "../../../src/shared/images.ts";

const NOW = Date.UTC(2026, 8, 13, 10, 0, 0);

const NONE: Offered = {
  tools: [],
  visuals: false,
  knowledge: true,
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

const policy: SendPolicy = {
  projectId: "p",
  userId: "u1",
  username: "casey",
  fullName: "Casey Doe",
  about: "I run clusters.",
  tz: "Europe/Bucharest",
  projectName: "ops",
  projectKind: "team",
  projectDescription: "Incidents and pages.",
  agentId: "a",
  agentName: "coder",
  summoned: null,
  providerId: "pr",
  providerName: "local",
  wire: "openai-compatible",
  model: "org/model",
  images: true,
  contextLength: 1000,
  price: null,
  prompt: "You write Go.",
  thinking: true,
  thinkingOff: false,
  thinkingRequired: false,
  effort: "high",
  upstream: null,
  skip4Bit: false,
  offered: NONE,
  disabledCapabilities: [],
  mcpOff: [],
  skillsOff: [],
  web: null,
  memoryOffered: null,
  attentionOffered: null,
  projectMemory: [],
  automationMemory: [],
  knowledge: { empty: true },
  automation: null,
  deadlineMs: null,
  limits: DEFAULT_LIMITS,
  toolCaps: DEFAULT_LIMITS,
  sendCaps: {
    sendsPerUser: 4,
    sendsPerProject: 16,
    sendsRunning: 64,
    sendsPerChannel: 4,
  },
};

const lookups: ContextLookups = {
  usernameOf: () => null,
  reasoningDetailsOf: () => null,
  turnsOf: () => new Map(),
};

let seq = 0;
const row = (
  fields: Partial<Message> & Pick<Message, "id" | "kind">,
): Message => ({
  sessionId: "s",
  uploads: null,
  files: null,
  saved: null,
  seq: ++seq,
  sendId: fields.id,
  round: 1,
  slot: null,
  userId: "u1",
  agentId: null,
  content: "",
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
  resultBytes: null,
  promptTokens: null,
  ...fields,
});

const pictures = (
  prefix: string,
  count: number,
  side = 2048,
  freed = false,
): MessageImage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    name: `${prefix}${i}.png`,
    mediaType: "image/png",
    width: side,
    height: side,
    freed,
  }));

// a user turn of images, answered
const turn = (id: string, images: MessageImage[]): Message[] => [
  row({ id: `${id}u`, kind: "user", content: id, images }),
  row({ id: `${id}r`, kind: "reply", userId: null, content: "seen" }),
];

const at = (
  window: number | null,
  wire: SendPolicy["wire"],
  model: string,
  imagesPerRequest = DEFAULT_LIMITS.imagesPerRequest,
): SendPolicy => ({
  ...policy,
  contextLength: window,
  wire,
  model,
  limits: { ...DEFAULT_LIMITS, imagesPerRequest },
});

const requestOf = (rows: Message[], p: SendPolicy): ChatRequest =>
  request(p, "s", history(rows, p, lookups, NOW));

describe("the check before a request", () => {
  test("at 32K the window binds, and a request past compactsAt is sent", () => {
    const p = at(32_768, "openai-compatible", "qwen3-vl");
    expect(imageTokens(p.wire, p.model, 2048, 2048)).toBe(5476);
    const eight = [row({ id: "u", kind: "user", images: pictures("a", 8) })];
    expect(unfitImages(requestOf(eight, p), p, 8)).toBe(imagesFit(5, 8));
    const five = requestOf(
      [row({ id: "u", kind: "user", images: pictures("a", 5) })],
      p,
    );
    expect(requestTokens(p.wire, five)).toBeGreaterThan(
      compactsAt(32_768, DEFAULT_LIMITS.contextReserve)!,
    );
    expect(unfitImages(five, p, 5)).toBeNull();
    // a round's own output cap comes off the window
    expect(unfitImages({ ...five, maxTokens: 6000 }, p, 5)).not.toBeNull();
  });

  test("at 200K imagesPerRequest binds before the window", () => {
    const p = at(200_000, "anthropic", "claude-opus-5");
    const rows = [
      ...turn("a", pictures("a", 10)),
      row({ id: "u", kind: "user", images: pictures("b", 12) }),
    ];
    expect(unfitImages(requestOf(rows, p), p, 12)).toBe(imagesFit(10, 12));
    // with room for 100, the window binds: 36 of 28 px patch images
    const wide = at(200_000, "openai-compatible", "qwen3-vl", 100);
    const many = [row({ id: "u", kind: "user", images: pictures("c", 40) })];
    expect(unfitImages(requestOf(many, wide), wide, 40)).toBe(
      imagesFit(36, 40),
    );
  });

  test("at 1M the count binds, and the history's images can leave none", () => {
    const p = at(1_000_000, "anthropic", "claude-opus-5", 100);
    const rows = [
      ...turn("a", pictures("a", 95)),
      row({ id: "u", kind: "user", images: pictures("b", 8) }),
    ];
    expect(unfitImages(requestOf(rows, p), p, 8)).toBe(imagesFit(5, 8));
    const full = [
      ...turn("a", pictures("a", 100)),
      row({ id: "u", kind: "user", images: pictures("b", 1) }),
    ];
    expect(unfitImages(requestOf(full, p), p, 1)).toBe(NO_IMAGE_ROOM);
    // a round with no new message names none
    expect(unfitImages(requestOf(full, p), p)).toBe(NO_IMAGE_ROOM);
  });

  test("with no window only imagesPerRequest applies", () => {
    const p = at(null, "openai-compatible", "qwen3-vl");
    const ok = [row({ id: "u", kind: "user", images: pictures("a", 20) })];
    expect(unfitImages(requestOf(ok, p), p, 20)).toBeNull();
    const over = [row({ id: "u", kind: "user", images: pictures("a", 21) })];
    expect(unfitImages(requestOf(over, p), p, 21)).toBe(imagesFit(20, 21));
  });

  test("a request without images is never checked", () => {
    const p = at(1000, "openai-compatible", "m");
    const long = [row({ id: "u", kind: "user", content: "x ".repeat(5000) })];
    expect(unfitImages(requestOf(long, p), p)).toBeNull();
  });
});

describe("images in history", () => {
  const userOf = (messages: ChatMessageIn[], content: string) =>
    messages.find(
      (message) => message.role === "user" && message.content === content,
    );

  test("an agent without images gets their lines, a freed one is always its line", () => {
    const rows = [
      row({
        id: "u",
        kind: "user",
        content: "look",
        images: [
          ...pictures("gone", 1, 640, true),
          ...pictures("live", 1, 640),
        ],
      }),
    ];
    const blind = history(rows, { ...policy, images: false }, lookups, NOW);
    expect(blind[1]).toEqual({
      role: "user",
      content:
        "look\n\n[image removed: gone0.png, 640x640]\n[image: live0.png, 640x640]",
      name: "casey",
    });
    const sees = history(rows, policy, lookups, NOW);
    expect(sees[1]).toEqual({
      role: "user",
      content: "look\n\n[image removed: gone0.png, 640x640]",
      name: "casey",
      images: [
        {
          id: "live0",
          name: "live0.png",
          mediaType: "image/png",
          width: 640,
          height: 640,
        },
      ],
    });
  });

  test("the images sent from history do not change between turns without a summary", () => {
    const p = at(200_000, "anthropic", "claude-opus-5");
    const first = [...turn("a", pictures("a", 3)), ...turn("b", [])];
    const second = [...first, ...turn("c", pictures("c", 2))];
    const one = history(first, p, lookups, NOW);
    const two = history(second, p, lookups, NOW);
    expect(two.slice(0, one.length)).toEqual(one);
    expect(imagePartsOf(one)).toHaveLength(3);
    expect(imagePartsOf(two)).toHaveLength(5);
  });

  test("after a summary the tail replays its images, at most half a request's", () => {
    const rows = [
      ...turn("a", pictures("a", 1, 1000)),
      ...turn("b", pictures("b", 1, 1000)),
      row({ id: "sum", kind: "summary", userId: null, content: "so far" }),
      row({ id: "n", kind: "user", content: "next" }),
    ];
    const wide = at(200_000, "openai-compatible", "qwen3-vl");
    const replayed = history(rows, wide, lookups, NOW);
    expect(replayed[1]?.content).toStartWith(SUMMARY_LEAD);
    expect(imagePartsOf(replayed).map((image) => image.id)).toEqual([
      "a0",
      "b0",
    ]);
    expect(userOf(replayed, "next")).toBeDefined();
    // two a request: the tail keeps the newest turn's one
    const two = at(200_000, "openai-compatible", "qwen3-vl", 2);
    expect(
      imagePartsOf(history(rows, two, lookups, NOW)).map((image) => image.id),
    ).toEqual(["b0"]);
    // at 32K the tail's 3,276 tokens take no 2048 image
    const big = [
      ...turn("a", pictures("a", 1)),
      row({ id: "sum", kind: "summary", userId: null, content: "so far" }),
      row({ id: "n", kind: "user", content: "next" }),
    ];
    const small = at(32_768, "openai-compatible", "qwen3-vl");
    const after = history(big, small, lookups, NOW);
    expect(imagePartsOf(after)).toHaveLength(0);
    expect(userOf(after, "a")).toBeUndefined();
  });

  test("the summary round reads the images, or their lines where they do not fit", () => {
    const summarizing = (p: SendPolicy) =>
      ({
        policy: p,
        sessionId: "s",
        mcpNote: "",
        repos: null,
        channel: null,
        round: null,
        summarizing: true,
        answering: null,
        bare: false,
        used: null,
        usedThrough: null,
        usedPrompt: null,
      }) as unknown as ActiveSend;
    const rows = turn("a", pictures("a", 2, 640));
    const fits = at(200_000, "openai-compatible", "qwen3-vl", 2);
    const read = buildRequest(summarizing(fits), rows, lookups, NOW);
    expect(imagePartsOf(read.messages)).toHaveLength(2);
    expect(read).toEqual(
      summaryRequest(fits, "s", history(rows, fits, lookups, NOW)),
    );
    const one = at(200_000, "openai-compatible", "qwen3-vl", 1);
    const lined = buildRequest(summarizing(one), rows, lookups, NOW);
    expect(imagePartsOf(lined.messages)).toHaveLength(0);
    expect(
      userOf(
        lined.messages,
        "a\n\n[image: a0.png, 640x640]\n[image: a1.png, 640x640]",
      ),
    ).toBeDefined();
  });
});
