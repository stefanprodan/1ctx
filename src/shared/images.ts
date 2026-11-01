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
