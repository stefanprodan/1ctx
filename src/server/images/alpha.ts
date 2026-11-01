// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Whether a PNG has a pixel that is not opaque. Bun.Image gives no
// pixels and no alpha flag, so the PNG ingest wrote is read back: a
// header that allows alpha says nothing of its use, and an opaque RGBA
// photo kept as PNG costs about eleven times its JPEG.

import { inflateSync } from "node:zlib";

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// true at the first pixel whose alpha is below 255; an 8-bit grey or
// RGB PNG without tRNS is opaque, and any other layout is taken as
// transparent, so it stays PNG
export function transparent(png: Uint8Array): boolean {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  const data: Uint8Array[] = [];
  while (at + 8 <= png.length) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (name === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8] ?? 0;
      type = body[9] ?? -1;
    } else if (name === "tRNS") {
      return true;
    } else if (name === "IDAT") {
      data.push(body);
    } else if (name === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (depth !== 8) return true;
  if (type === 0 || type === 2) return false;
  const channels = type === 6 ? 4 : type === 4 ? 2 : 0;
  if (channels === 0) return true;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  let previous = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    for (let i = 0; i < stride; i++) {
      const x = raw[start + 1 + i]!;
      const a = i >= channels ? row[i - channels]! : 0;
      const b = previous[i]!;
      switch (filter) {
        case 1:
          row[i] = x + a;
          break;
        case 2:
          row[i] = x + b;
          break;
        case 3:
          row[i] = x + ((a + b) >> 1);
          break;
        case 4:
          row[i] = x + paeth(a, b, i >= channels ? previous[i - channels]! : 0);
          break;
        default:
          row[i] = x;
      }
    }
    for (let i = channels - 1; i < stride; i += channels) {
      if (row[i] !== 255) return true;
    }
    [previous, row] = [row, previous];
  }
  return false;
}
