// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one WAV a clip may be: the canonical 44-byte header the composer
// writes, then 16-bit PCM, mono, 16 kHz. Only the header is read, so a
// clip is never decoded here; the provider decodes it.

import {
  DICTATION_BITS,
  DICTATION_BYTES_PER_SECOND,
  DICTATION_CHANNELS,
  DICTATION_SAMPLE_RATE,
  WAV_HEADER_BYTES,
} from "../../shared/contracts/dictation.ts";
import { type Checked, refused } from "../lib/errors.ts";

export type Clip = {
  // the PCM bytes after the header
  dataBytes: number;
  // the clip's length, from its data size
  seconds: number;
};

const tag = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(...bytes.subarray(at, at + 4));

export function parseWav(bytes: Uint8Array): Checked<Clip> {
  if (bytes.byteLength < WAV_HEADER_BYTES) {
    return refused("the clip is not a WAV file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") {
    return refused("the clip is not a WAV file");
  }
  if (view.getUint32(4, true) !== bytes.byteLength - 8) {
    return refused("the clip's RIFF size does not match its body");
  }
  if (tag(bytes, 12) !== "fmt " || view.getUint32(16, true) !== 16) {
    return refused("the clip's header is not the 44-byte one");
  }
  const blockAlign = (DICTATION_CHANNELS * DICTATION_BITS) / 8;
  if (
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== DICTATION_CHANNELS ||
    view.getUint32(24, true) !== DICTATION_SAMPLE_RATE ||
    view.getUint32(28, true) !== DICTATION_BYTES_PER_SECOND ||
    view.getUint16(32, true) !== blockAlign ||
    view.getUint16(34, true) !== DICTATION_BITS
  ) {
    return refused("the clip must be 16-bit PCM, mono, 16 kHz");
  }
  if (tag(bytes, 36) !== "data") {
    return refused("the clip's header is not the 44-byte one");
  }
  const dataBytes = view.getUint32(40, true);
  if (dataBytes !== bytes.byteLength - WAV_HEADER_BYTES) {
    return refused("the clip's data size does not match its body");
  }
  if (dataBytes === 0 || dataBytes % blockAlign !== 0) {
    return refused("the clip holds no whole samples");
  }
  return {
    ok: true,
    value: { dataBytes, seconds: dataBytes / DICTATION_BYTES_PER_SECOND },
  };
}
