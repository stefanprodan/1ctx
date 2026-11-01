// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What an upload's bytes are, read from their headers and never from the
// client's word: one of the four admitted rasters with whether it may
// hold transparency, or the reason it is refused.

export type Sniffed = {
  format: "jpeg" | "png" | "webp" | "gif";
  // the header allows transparent pixels: kept as PNG
  alpha: boolean;
};

export type SniffResult =
  | { ok: true; image: Sniffed }
  | { ok: false; words: string };

export const NOT_AN_IMAGE = "this is not a JPEG, PNG, WebP or GIF image";
export const SVG_REFUSED = "an SVG is not taken as an image, add it as a file";
export const HEIC_REFUSED =
  "HEIC images are not supported, use JPEG or PNG instead";
export const AVIF_REFUSED =
  "AVIF images are not supported, use JPEG or PNG instead";

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

const starts = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  bytes.length >= at + signature.length &&
  signature.every((byte, i) => bytes[at + i] === byte);

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

// colour types 4 and 6 carry alpha; a tRNS chunk before the data gives
// another type a transparent colour
function pngAlpha(bytes: Uint8Array): boolean {
  if (bytes[25] === 4 || bytes[25] === 6) return true;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 8 <= bytes.length) {
    const type = ascii(bytes, at + 4, 4);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    at += 12 + view.getUint32(at);
  }
  return false;
}

// VP8X carries an alpha flag, VP8L an alpha bit; plain VP8 has none
function webpAlpha(bytes: Uint8Array): boolean {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") return ((bytes[20] ?? 0) & 0x10) !== 0;
  if (chunk === "VP8L") return ((bytes[24] ?? 0) & 0x10) !== 0;
  return false;
}

// the first frame's graphic control extension, before its descriptor,
// says whether one colour is transparent
function gifAlpha(bytes: Uint8Array): boolean {
  const flags = bytes[10] ?? 0;
  let at = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  while (at < bytes.length) {
    const block = bytes[at];
    if (block === 0x2c || block === 0x3b) return false;
    if (block !== 0x21) return false;
    const label = bytes[at + 1];
    if (label === 0xf9) return ((bytes[at + 3] ?? 0) & 1) !== 0;
    at += 2;
    while (at < bytes.length && bytes[at] !== 0) at += 1 + bytes[at]!;
    at += 1;
  }
  return false;
}

// markup: an optional BOM and whitespace, then a tag
function isMarkup(bytes: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 512))
    .replace(/^﻿/, "")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml");
}

export function sniff(bytes: Uint8Array): SniffResult {
  const found = (format: Sniffed["format"], alpha: boolean): SniffResult => ({
    ok: true,
    image: { format, alpha },
  });
  if (starts(bytes, [0xff, 0xd8, 0xff])) return found("jpeg", false);
  if (starts(bytes, PNG) && bytes.length >= 33) {
    return found("png", pngAlpha(bytes));
  }
  if (
    bytes.length >= 30 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return found("webp", webpAlpha(bytes));
  }
  const gif = ascii(bytes, 0, 6);
  if ((gif === "GIF87a" || gif === "GIF89a") && bytes.length >= 13) {
    return found("gif", gifAlpha(bytes));
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (HEIC_BRANDS.has(brand)) return { ok: false, words: HEIC_REFUSED };
    if (AVIF_BRANDS.has(brand)) return { ok: false, words: AVIF_REFUSED };
  }
  if (isMarkup(bytes)) return { ok: false, words: SVG_REFUSED };
  return { ok: false, words: NOT_AN_IMAGE };
}
