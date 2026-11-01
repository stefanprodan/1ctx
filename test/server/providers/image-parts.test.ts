// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user message's images on each wire, their cache marks and their
// token estimate, on fixtures.

import { describe, expect, test } from "bun:test";
import { buildChatBody as anthropicBody } from "../../../src/server/providers/anthropic.ts";
import { buildChatBody as azureBody } from "../../../src/server/providers/azure.ts";
import {
  type ImageData,
  imageTokens,
  requestText,
  requestTokens,
  withImagesAsLines,
} from "../../../src/server/providers/index.ts";
import type {
  ChatMessageIn,
  ChatRequest,
  ImagePart,
} from "../../../src/server/providers/types.ts";
import { CHAT_WIRES } from "../../../src/server/providers/wires.ts";

const SHOT: ImagePart = {
  id: "i1",
  name: "shot.png",
  mediaType: "image/png",
  width: 1000,
  height: 1000,
  bytes: 4,
};
const GONE: ImagePart = { ...SHOT, id: "i2", name: "gone.jpg" };
const BYTES = new Uint8Array([1, 2, 3, 4]);
const BASE64 = Buffer.from(BYTES).toString("base64");
const read: ImageData = (id) => (id === "i1" ? BYTES : null);

const req = (
  model: string,
  user: Partial<Extract<ChatMessageIn, { role: "user" }>> = {},
): ChatRequest => ({
  model,
  thinking: false,
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "look", images: [SHOT], ...user },
  ],
});

type Body = { messages: { role: string; content: unknown }[] };
const lastUser = (body: Record<string, unknown>) =>
  (body as Body).messages.filter((m) => m.role === "user").at(-1)!.content;

describe("the chat completions wires", () => {
  test.each([
    "openrouter",
    "openai-compatible",
    "openai-strict",
    "gemini",
    "opencode",
  ] as const)("%s sends the text, then the image as a data URL", (wire) => {
    const body = CHAT_WIRES[wire].body(req("vendor/model"), read);
    expect(lastUser(body)).toEqual([
      { type: "text", text: "look" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${BASE64}` },
      },
    ]);
  });

  test("images alone send no text part, and a freed one goes as its line", () => {
    const alone = CHAT_WIRES.openrouter.body(
      req("vendor/model", { content: "" }),
      read,
    );
    expect(lastUser(alone)).toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${BASE64}` },
      },
    ]);
    const freed = CHAT_WIRES["openai-compatible"].body(
      req("m", { images: [SHOT, GONE] }),
      read,
    );
    expect(lastUser(freed)).toEqual([
      { type: "text", text: "look\n\n[image removed: gone.jpg, 1000x1000]" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${BASE64}` },
      },
    ]);
    // every image gone is the plain string as before
    const none = CHAT_WIRES.gemini.body(req("m", { images: [GONE] }), read);
    expect(lastUser(none)).toBe("look\n\n[image removed: gone.jpg, 1000x1000]");
  });

  test("OpenRouter's cache mark on a Claude model sits on the last part", () => {
    const body = CHAT_WIRES.openrouter.body(
      req("anthropic/claude-opus-5"),
      read,
    );
    const parts = lastUser(body) as Record<string, unknown>[];
    expect(parts[0]).toEqual({ type: "text", text: "look" });
    expect(parts[1]).toMatchObject({
      type: "image_url",
      cache_control: { type: "ephemeral" },
    });
  });

  test("a request held in memory carries ids, never base64", () => {
    const r = req("m");
    expect(JSON.stringify(r)).not.toContain(BASE64);
  });
});

describe("the azure wire", () => {
  test("sends input_text, then input_image with a plain string URL", () => {
    const body = azureBody(req("gpt-5.6-luna", { name: "casey" }), {
      images: read,
    });
    const input = body.input as { role?: string; content?: unknown }[];
    expect(input.find((item) => item.role === "user")?.content).toEqual([
      { type: "input_text", text: "[casey] look" },
      { type: "input_image", image_url: `data:image/png;base64,${BASE64}` },
    ]);
  });
});

describe("the anthropic wire", () => {
  test("sends text, then a base64 image source, the mark on the image", () => {
    const body = anthropicBody(
      { ...req("claude-opus-5"), cacheLife: "long" },
      { images: read },
    );
    const turns = body.messages as { role: string; content: unknown[] }[];
    expect(turns[0]!.content).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: BASE64 },
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });
});

describe("the token estimate", () => {
  test.each([
    // https://platform.claude.com/docs/en/build-with-claude/vision tables
    ["anthropic", "claude-haiku-4-5-20251001", 1000, 1000, 1296],
    ["anthropic", "claude-sonnet-4-5", 1920, 1080, 1568],
    ["anthropic", "claude-opus-4-7", 1920, 1080, 2691],
    ["openrouter", "anthropic/claude-opus-5", 2048, 2048, 4784],
    ["openrouter", "anthropic/claude-3.5-sonnet", 2048, 2048, 1568],
    // tile models: fit 2048, short side 768, base + tile per 512
    ["azure", "gpt-4o", 1024, 1024, 765],
    ["opencode", "gpt-5.1", 2048, 2048, 630],
    // patch models: ceil(multiplier * 32 px patches)
    ["azure", "gpt-5.6-luna", 1024, 1024, 1229],
    ["openrouter", "openai/gpt-4.1-mini", 1024, 1024, 1659],
    ["azure", "my-deployment", 64, 64, 5],
    // Gemini 2: 258 within 384, else per 768 tile; 3 and later 1,120
    ["gemini", "gemini-2.5-flash", 384, 384, 258],
    ["gemini", "gemini-2.5-flash", 1000, 1000, 1032],
    // the doc's own: a 360 crop unit, 3 x 2 tiles
    ["gemini", "gemini-2.0-flash", 960, 540, 1548],
    ["gemini", "gemini-2.5-pro", 2048, 100, 16_512],
    ["openrouter", "google/gemini-3-pro-preview", 2048, 2048, 1120],
    ["gemini", "gemini-flash-latest", 2048, 2048, 1120],
    ["gemini", "gemini-flash-latest", 3000, 1000, 2580],
    // any other: a token per 28 px patch, uncapped
    ["openai-compatible", "qwen3-vl", 2048, 2048, 5476],
  ] as const)("%s %s %ix%i is %i", (wire, model, w, h, expected) => {
    expect(imageTokens(wire, model, w, h)).toBe(expected);
  });

  test.each(["openrouter", "azure", "anthropic"] as const)(
    "%s counts an image by its estimate, never its bytes",
    (wire) => {
      const model = "claude-opus-5";
      const plain = req(model, { images: [] });
      const withImage = req(model);
      expect(requestTokens(wire, withImage)).toBe(
        requestTokens(wire, plain) + imageTokens(wire, model, 1000, 1000),
      );
      expect(requestText(wire, withImage)).not.toContain("i1");
    },
  );

  test("as lines, a request carries no part and counts the lines", () => {
    const lines = withImagesAsLines(req("m").messages);
    expect(lines[1]).toEqual({
      role: "user",
      content: "look\n\n[image: shot.png, 1000x1000]",
    });
  });
});
