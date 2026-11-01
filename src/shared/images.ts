// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The images a user message carries, as the wire and the text readers
// see them. Pure: an image's line changes only once, when the budget
// frees it, so a replayed history and its tail read the same bytes
// between frees.

// the claim's refusals the composer acts on, and the channel's
export const CANNOT_READ_IMAGES = "this agent cannot read images";
export const IMAGE_GONE = "an image is gone, add it again";
export const CHANNEL_NO_IMAGES = "a channel post cannot carry images";

// a request whose images pass the window or imagesPerRequest: how many
// of the new message's images fit, none when the history's are the cause
export const NO_IMAGE_ROOM =
  "no more images fit in this chat: compact it or start a new one";
export const imagesFit = (fit: number, of: number): string =>
  fit === 0
    ? NO_IMAGE_ROOM
    : `only ${fit} of these ${of} images fit in this chat`;

// the most stored image bytes one request carries, base64 a third more
// on the wire: under Gemini's 20 MB for a whole request with inline data
// (https://ai.google.dev/gemini-api/docs/image-understanding), the
// smallest whole-request limit of the wires served, with room for a long
// history's text; Anthropic's Messages API takes 128 MB
// (https://platform.claude.com/docs/en/api/overview) and OpenAI's 512 MB
// (https://developers.openai.com/api/docs/guides/images-vision). It
// also bounds a request's memory
export const IMAGE_REQUEST_BYTES = 12 * 1024 * 1024;
// a request past this makes the summary due, and a tail holds at most
// the half, so the next message has room and a summary is never due at
// once
export const IMAGE_DUE_BYTES = (IMAGE_REQUEST_BYTES * 3) / 4;
export const IMAGE_TAIL_BYTES = IMAGE_REQUEST_BYTES / 2;

// the most images one message may name, imagesPerMessage's ceiling; the
// limit itself is checked at the claim
export const MAX_IMAGES_PER_MESSAGE = 12;

// a sent image without its bytes; freed once the project's budget took
// them, its name and size kept
export type MessageImage = {
  id: string;
  name: string;
  mediaType: string;
  width: number;
  height: number;
  // the stored size, which a request's byte bound counts; absent on a
  // row read before it was carried
  bytes?: number;
  freed: boolean;
};

// one line per image wherever a message is read as text
export const imageLine = (image: MessageImage): string =>
  `[${image.freed ? "image removed" : "image"}: ${image.name}, ${image.width}x${image.height}]`;

export const imageLines = (images: readonly MessageImage[]): string =>
  images.map(imageLine).join("\n");

// the text with its image lines after it; the lines alone for a
// message of images only
export const withImageLines = (
  text: string,
  images: readonly MessageImage[] | undefined,
): string =>
  !images?.length
    ? text
    : text === ""
      ? imageLines(images)
      : `${text}\n\n${imageLines(images)}`;
