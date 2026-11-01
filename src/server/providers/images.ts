// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user message's images on the wire (docs/images.md, The wires): their
// parts read into bytes only when a body is built, and their tokens
// counted by an estimate, never by the base64's length.

import { imageLine } from "../../shared/images.ts";
import type { Wire } from "../../shared/words.ts";
import type { ChatMessageIn, ChatRequest, ImagePart } from "./types.ts";

// the images port: a sent image's bytes, null once freed or gone
export type ImageData = (id: string) => Uint8Array | null;

export const NO_IMAGE_DATA: ImageData = () => null;

// a part's bytes as the wires take them, or its removed line when the
// budget freed them after the history was read
export type LoadedImage =
  | { mediaType: string; data: string }
  | { line: string };

export function loadImage(image: ImagePart, read: ImageData): LoadedImage {
  const bytes = read(image.id);
  if (bytes === null) return { line: imageLine({ ...image, freed: true }) };
  return {
    mediaType: image.mediaType,
    data: Buffer.from(bytes).toString("base64"),
  };
}

export const dataUrl = (image: { mediaType: string; data: string }) =>
  `data:${image.mediaType};base64,${image.data}`;

// a user message's text with the lines of the images that lost their
// bytes, and the loaded ones in order
export function loadImages(
  text: string,
  images: readonly ImagePart[] | undefined,
  read: ImageData,
): { text: string; loaded: { mediaType: string; data: string }[] } {
  const loaded: { mediaType: string; data: string }[] = [];
  const lines: string[] = [];
  for (const image of images ?? []) {
    const one = loadImage(image, read);
    if ("line" in one) lines.push(one.line);
    else loaded.push(one);
  }
  if (lines.length === 0) return { text, loaded };
  const block = lines.join("\n");
  return { text: text === "" ? block : `${text}\n\n${block}`, loaded };
}

// a chat completions user message's content: the text alone, or with
// images a part list, the text first (none when empty), then each image
// as a data URL
export function chatUserContent(
  text: string,
  images: readonly ImagePart[] | undefined,
  read: ImageData,
): string | Record<string, unknown>[] {
  if (!images?.length) return text;
  const loaded = loadImages(text, images, read);
  if (loaded.loaded.length === 0) return loaded.text;
  return [
    ...(loaded.text === "" ? [] : [{ type: "text", text: loaded.text }]),
    ...loaded.loaded.map((image) => ({
      type: "image_url",
      image_url: { url: dataUrl(image) },
    })),
  ];
}

export type ImageFamily = "anthropic" | "openai" | "gemini" | "other";

// the model's own name, past a router's or a host's prefix
const bare = (model: string) => model.toLowerCase().split("/").at(-1) ?? "";

export function imageFamily(wire: Wire | null, model: string): ImageFamily {
  const id = bare(model);
  if (wire === "anthropic" || id.includes("claude")) return "anthropic";
  if (wire === "gemini" || id.includes("gemini")) return "gemini";
  if (
    wire === "azure" ||
    /^(gpt-|chatgpt|o\d)/.test(id) ||
    model.toLowerCase().startsWith("openai/")
  ) {
    return "openai";
  }
  return "other";
}

// the first major.minor in a name (4-7, 4.7, 5), null without one
function version(id: string): number | null {
  const match = /(?:^|[-_.])(\d+)(?:[-.](\d))?(?=$|[-_.a-z])/.exec(id);
  if (match === null) return null;
  return Number(match[1]) + Number(match[2] ?? 0) / 10;
}

// https://platform.claude.com/docs/en/build-with-claude/vision
// (Resolution and token cost): ceil(w/28) * ceil(h/28) visual tokens,
// downscaled past 1,568 on standard models and 4,784 on Claude 4.7 and
// later; a name without a version takes the higher cap
function anthropicTokens(model: string, w: number, h: number): number {
  const id = bare(model);
  // the old names put the version first: claude-3-5-sonnet
  const v = version(
    id.replace(/^claude-/, "").replace(/^(\d)-(\d)-/, "$1.$2-"),
  );
  const cap = v !== null && v < 4.7 ? 1568 : 4784;
  return Math.min(cap, Math.ceil(w / 28) * Math.ceil(h / 28));
}

// https://developers.openai.com/api/docs/guides/images-vision
// (Calculating costs). Tile models: fit in 2048, shortest side to 768,
// base + tile tokens per 512 square
const TILES: [RegExp, number, number][] = [
  [/^gpt-4o-mini/, 2833, 5667],
  [/^(gpt-4o|gpt-4\.1)(?!-mini|-nano)/, 85, 170],
  [/^gpt-5(\.1)?(?![.\d]|-mini|-nano)/, 70, 140],
  [/^o[13](?!\d|-mini)/, 75, 150],
];
// patch models: ceil(1.2 or the model's multiplier * 32 px patches);
// no patch budget is applied, since auto keeps the original size on the
// newest models, so the figure errs high on the others
const MULTIPLIERS: [RegExp, number][] = [
  [/^gpt-4\.1-nano/, 2.46],
  [/^o4-mini/, 1.72],
  [/^gpt-4\.1-mini/, 1.62],
  [/^gpt-5-nano/, 1.5],
];

function openAiTokens(model: string, w: number, h: number): number {
  const id = bare(model);
  const tile = TILES.find(([pattern]) => pattern.test(id));
  if (tile !== undefined) {
    let width = w;
    let height = h;
    const fit = Math.min(1, 2048 / Math.max(width, height));
    width *= fit;
    height *= fit;
    const short = Math.min(width, height);
    if (short > 768) {
      width = Math.floor((width * 768) / short);
      height = Math.floor((height * 768) / short);
    }
    const squares = Math.ceil(width / 512) * Math.ceil(height / 512);
    return tile[1] + tile[2] * squares;
  }
  const multiplier =
    MULTIPLIERS.find(([pattern]) => pattern.test(id))?.[1] ?? 1.2;
  return Math.ceil(multiplier * Math.ceil(w / 32) * Math.ceil(h / 32));
}

// https://ai.google.dev/gemini-api/docs/tokens: 258 for an image within
// 384 on both sides, else 258 per 768 tile; Gemini 3 and later take
// 1,120 at the default resolution
// (https://ai.google.dev/gemini-api/docs/media-resolution). A name
// without a version takes the larger
function geminiTokens(model: string, w: number, h: number): number {
  const tiles =
    w <= 384 && h <= 384 ? 258 : Math.ceil(w / 768) * Math.ceil(h / 768) * 258;
  const v = version(bare(model).replace(/^gemini-/, ""));
  if (v !== null && v < 3) return tiles;
  if (v !== null) return 1120;
  return Math.max(1120, tiles);
}

// one image's tokens on the wire. Any other model: a 28 px patch a token,
// uncapped, the common vision encoder's grid (14 px patches merged two by
// two), which errs high on a model that downscales
export function imageTokens(
  wire: Wire | null,
  model: string,
  width: number,
  height: number,
): number {
  switch (imageFamily(wire, model)) {
    case "anthropic":
      return anthropicTokens(model, width, height);
    case "openai":
      return openAiTokens(model, width, height);
    case "gemini":
      return geminiTokens(model, width, height);
    default:
      return Math.ceil(width / 28) * Math.ceil(height / 28);
  }
}

// the image parts a request carries, in order
export function imagePartsOf(
  messages: readonly ChatMessageIn[],
): readonly ImagePart[] {
  return messages.flatMap((message) =>
    message.role === "user" ? (message.images ?? []) : [],
  );
}

export function requestImageTokens(
  wire: Wire | null,
  req: Pick<ChatRequest, "model" | "messages">,
): number {
  let total = 0;
  for (const image of imagePartsOf(req.messages)) {
    total += imageTokens(wire, req.model, image.width, image.height);
  }
  return total;
}

// every image part as its line, for a request that cannot carry them
export function withImagesAsLines(
  messages: readonly ChatMessageIn[],
): ChatMessageIn[] {
  return messages.map((message) => {
    if (message.role !== "user" || !message.images?.length) return message;
    const { images, ...rest } = message;
    const lines = images
      .map((image) => imageLine({ ...image, freed: false }))
      .join("\n");
    return {
      ...rest,
      content: rest.content === "" ? lines : `${rest.content}\n\n${lines}`,
    };
  });
}

// a request as counted text holds no image part
export function withoutImages(
  messages: readonly ChatMessageIn[],
): ChatMessageIn[] {
  return messages.map((message) => {
    if (message.role !== "user" || message.images === undefined) {
      return message;
    }
    const { images: _, ...rest } = message;
    return rest;
  });
}
