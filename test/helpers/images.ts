// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Synthetic images for the ingest tests, built byte by byte so no real
// photo is ever committed: PNGs from a pixel function, GIFs of flat
// frames, an Exif segment with an orientation and a GPS IFD, and a
// reader of the RGBA PNGs Bun writes.

import { deflateSync, inflateSync } from "node:zlib";

type Pixel = readonly [number, number, number, number];

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// an 8-bit RGB or RGBA PNG; declared puts other dimensions in its
// header, a decompression bomb's lie
export function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Pixel,
  options: { alpha?: boolean; declared?: [number, number] } = {},
): Uint8Array<ArrayBuffer> {
  const channels = options.alpha ? 4 : 3;
  const row = width * channels + 1;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw.set(pixel(x, y).slice(0, channels), y * row + 1 + x * channels);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, options.declared?.[0] ?? width);
  view.setUint32(4, options.declared?.[1] ?? height);
  header[8] = 8;
  header[9] = options.alpha ? 6 : 2;
  return new Uint8Array(
    Buffer.concat([
      new Uint8Array(SIGNATURE),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

// a GIF89a of flat frames over a four-colour table; each frame is one
// index. The LZW stream clears every two codes so its width stays 3
export function gif(
  width: number,
  height: number,
  palette: readonly [number, number, number][],
  frames: readonly number[],
  transparent?: number,
): Uint8Array<ArrayBuffer> {
  const u16 = (v: number) => [v & 255, v >> 8];
  const out: number[] = [
    ...new TextEncoder().encode("GIF89a"),
    ...u16(width),
    ...u16(height),
    0xf1,
    0,
    0,
  ];
  for (let i = 0; i < 4; i++) out.push(...(palette[i] ?? [0, 0, 0]));
  for (const index of frames) {
    out.push(0x21, 0xf9, 4, transparent === undefined ? 0 : 1, 10, 0);
    out.push(transparent ?? 0, 0);
    out.push(0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0, 2);
    const codes: number[] = [];
    for (let i = 0; i < width * height; i += 2) {
      codes.push(4, index);
      if (i + 1 < width * height) codes.push(index);
    }
    codes.push(5);
    const bytes: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const code of codes) {
      acc |= code << bits;
      bits += 3;
      while (bits >= 8) {
        bytes.push(acc & 255);
        acc >>= 8;
        bits -= 8;
      }
    }
    if (bits > 0) bytes.push(acc & 255);
    for (let i = 0; i < bytes.length; i += 255) {
      const part = bytes.slice(i, i + 255);
      out.push(part.length, ...part);
    }
    out.push(0);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

// the JPEG with an APP1 Exif segment after its SOI: IFD0 holds the
// orientation and a pointer to a GPS IFD with a latitude reference
export function withExif(
  jpeg: Uint8Array,
  orientation: number,
): Uint8Array<ArrayBuffer> {
  const u16 = (v: number) => [v & 255, v >> 8];
  const u32 = (v: number) => [
    v & 255,
    (v >> 8) & 255,
    (v >> 16) & 255,
    v >>> 24,
  ];
  const gpsAt = 8 + 2 + 2 * 12 + 4;
  const tiff = [
    ...[0x49, 0x49, 0x2a, 0, 8, 0, 0, 0],
    ...u16(2),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u16(0x8825),
    ...u16(4),
    ...u32(1),
    ...u32(gpsAt),
    ...u32(0),
    ...u16(1),
    ...u16(0x0001),
    ...u16(2),
    ...u32(2),
    0x4e,
    0,
    0,
    0,
    ...u32(0),
  ];
  const body = [...new TextEncoder().encode("Exif"), 0, 0, ...tiff];
  const length = body.length + 2;
  const segment = [0xff, 0xe1, length >> 8, length & 255, ...body];
  return new Uint8Array(
    Buffer.concat([
      jpeg.subarray(0, 2),
      new Uint8Array(segment),
      jpeg.subarray(2),
    ]),
  );
}

// the APP segments of a JPEG before its scan, as names: Exif, JFIF or
// the marker in hex
export function jpegSegments(jpeg: Uint8Array): string[] {
  const out: string[] = [];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1]!;
    if (marker === 0xda) break;
    const length = (jpeg[at + 2]! << 8) | jpeg[at + 3]!;
    const tag = String.fromCharCode(...jpeg.subarray(at + 4, at + 8));
    out.push(tag === "Exif" || tag === "JFIF" ? tag : marker.toString(16));
    at += 2 + length;
  }
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// the RGBA pixel at x, y of an 8-bit RGBA PNG, as Bun writes them
export function pixelAt(file: Uint8Array, x: number, y: number): Pixel {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 8;
  let width = 0;
  const data: Uint8Array[] = [];
  while (at < file.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = new DataView(body.buffer, body.byteOffset).getUint32(0);
      if (body[8] !== 8 || body[9] !== 6) throw new Error("not 8-bit RGBA");
    }
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  let previous = new Uint8Array(stride);
  for (let row = 0; row <= y; row++) {
    const filter = raw[row * (stride + 1)]!;
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const out = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[i - 4]! : 0;
      const b = previous[i]!;
      const c = i >= 4 ? previous[i - 4]! : 0;
      const predicted =
        filter === 1
          ? a
          : filter === 2
            ? b
            : filter === 3
              ? (a + b) >> 1
              : filter === 4
                ? paeth(a, b, c)
                : 0;
      out[i] = (line[i]! + predicted) & 255;
    }
    previous = out;
  }
  const i = x * 4;
  return [previous[i]!, previous[i + 1]!, previous[i + 2]!, previous[i + 3]!];
}

// seeded, so a photo-like image is the same bytes on every run
export function noise(seed = 1): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

// a screen's flat panels and lines of text, and a photo's gradients
// and grain: the two ends the JPEG or PNG choice is settled on
export function screenshot(
  width = 1200,
  height = 800,
): Uint8Array<ArrayBuffer> {
  return png(width, height, (x, y) => {
    if (y < 40) return [40, 44, 52, 255];
    if (x < 200) return [245, 245, 245, 255];
    const line = Math.floor((y - 60) / 18);
    const ink = (y - 60) % 18 < 10 && (x * 7 + line * 13) % 11 < 6;
    return ink && x < 900 ? [30, 30, 30, 255] : [255, 255, 255, 255];
  });
}

export function photo(width = 1200, height = 800): Uint8Array<ArrayBuffer> {
  const random = noise();
  return png(width, height, (x, y) => {
    const grain = random() * 40;
    return [
      Math.min(255, (x / width) * 200 + grain),
      Math.min(255, (y / height) * 180 + grain),
      Math.min(255, 120 + Math.sin(x / 50) * 60 + grain),
      255,
    ];
  });
}
