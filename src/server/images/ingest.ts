// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One image in, the one kept out: sniffed, refused past its pixels
// before a decode, oriented, fitted to the long side and re-encoded,
// which drops its metadata. A JPEG stays JPEG; an image that may be
// transparent becomes PNG; any other is PNG when that loses nothing at
// little cost, as a screenshot or line art does, else JPEG.

import { BadRequest } from "../lib/errors.ts";
import { type Sniffed, sniff } from "./sniff.ts";

export type StoredType = "image/jpeg" | "image/png";

export type Ingested = {
  mediaType: StoredType;
  data: Uint8Array;
  width: number;
  height: number;
  digest: string;
};

export type IngestCaps = { maxPixels: number; longSide: number };

export const JPEG_QUALITY = 85;
// a PNG at most this many times the JPEG's size is kept: measured on
// fixtures, a screenshot's PNG is a fraction of its JPEG and a photo's
// five to eleven times it
export const PNG_RATIO = 1.5;

export const UNREADABLE = "the image could not be read";

export const tooManyPixels = (max: number) =>
  `the image is larger than ${Math.floor(max / 1_000_000)} megapixels`;

// the choice between two encodings of one image; null is not encoded
export function keepsPng(
  source: Sniffed,
  png: number | null,
  jpeg: number | null,
): boolean {
  if (source.alpha || jpeg === null) return true;
  if (source.format === "jpeg" || png === null) return false;
  return png <= jpeg * PNG_RATIO;
}

const code = (error: unknown): string | null => {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === "string" ? value : null;
};

// Bun's refusals as their words; any other throw is a bug
function refusal(error: unknown, caps: IngestCaps): never {
  const found = code(error);
  if (found === "ERR_IMAGE_TOO_MANY_PIXELS") {
    throw new BadRequest(tooManyPixels(caps.maxPixels));
  }
  if (found?.startsWith("ERR_IMAGE_")) throw new BadRequest(UNREADABLE);
  throw error;
}

type Encoded = { data: Uint8Array; width: number; height: number };

export async function ingest(
  bytes: Uint8Array,
  caps: IngestCaps,
): Promise<Ingested> {
  const sniffed = sniff(bytes);
  if (!sniffed.ok) throw new BadRequest(sniffed.words);
  const source = sniffed.image;
  const options = { maxPixels: caps.maxPixels, autoOrient: true };
  try {
    // the header alone: a bomb is refused before any pixel is held
    const meta = await new Bun.Image(bytes, options).metadata();
    if (meta.format !== source.format) throw new BadRequest(UNREADABLE);
    const encode = async (type: StoredType): Promise<Encoded> => {
      const fitted = new Bun.Image(bytes, options).resize(
        caps.longSide,
        caps.longSide,
        { fit: "inside", withoutEnlargement: true },
      );
      const image =
        type === "image/jpeg"
          ? fitted.jpeg({ quality: JPEG_QUALITY })
          : fitted.png();
      const data = await image.bytes();
      return { data, width: image.width, height: image.height };
    };
    const jpeg = source.alpha ? null : await encode("image/jpeg");
    const png = source.format === "jpeg" ? null : await encode("image/png");
    const pick = keepsPng(
      source,
      png?.data.length ?? null,
      jpeg?.data.length ?? null,
    );
    const kept = (pick ? png : jpeg)!;
    return {
      mediaType: pick ? "image/png" : "image/jpeg",
      ...kept,
      digest: new Bun.CryptoHasher("sha256").update(kept.data).digest("hex"),
    };
  } catch (error) {
    if (error instanceof BadRequest) throw error;
    refusal(error, caps);
  }
}
