// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure parts of the composer's mic: whether the browser can record,
// the downsampler that turns the device's frames into 16 kHz mono, the
// WAV the server takes, the level a chunk draws, the clock, where the
// words land in the draft, and the failure line. No DOM and no audio
// node here, so every part runs on fixtures.

import {
  DICTATION_BITS,
  DICTATION_BYTES_PER_SECOND,
  DICTATION_CHANNELS,
  DICTATION_MAX_SECONDS,
  DICTATION_SAMPLE_RATE,
  WAV_HEADER_BYTES,
} from "../../shared/contracts/dictation.ts";

// the samples a clip may hold before it stops on its own
export const MAX_SAMPLES = DICTATION_MAX_SECONDS * DICTATION_SAMPLE_RATE;
// a tap and stop: dropped without a request, since it would cost a clip
// and count against the cap for no words
export const MIN_SAMPLES = DICTATION_SAMPLE_RATE / 2;

export const NO_WORDS = "Dictation: no words heard";

// the browser records only in a secure context, with getUserMedia, and
// the capture graph needs an AudioWorklet
export function canRecord(scope: {
  isSecureContext?: boolean;
  navigator?: { mediaDevices?: { getUserMedia?: unknown } };
  AudioWorkletNode?: unknown;
}): boolean {
  return (
    scope.isSecureContext === true &&
    typeof scope.navigator?.mediaDevices?.getUserMedia === "function" &&
    typeof scope.AudioWorkletNode === "function"
  );
}

// From the device's rate to DICTATION_SAMPLE_RATE: each output sample is the
// mean of the input over its window, fractional edges weighted, which is
// a box low-pass before the decimation, so speech keeps no alias hiss.
// Chunks arrive in any size; what a window still needs waits for the next.
export class Downsampler {
  private readonly from: number;
  // input not yet consumed whole, the absolute index of its first
  // sample, and the next output's index; each window's edges are worked
  // out from these whole numbers, so chunking never moves them
  private rest = new Float32Array(0);
  private offset = 0;
  private k = 0;

  constructor(fromRate: number) {
    this.from = fromRate;
  }

  private edge(k: number): number {
    return (k * this.from) / DICTATION_SAMPLE_RATE - this.offset;
  }

  push(chunk: Float32Array): Int16Array {
    const buf = new Float32Array(this.rest.length + chunk.length);
    buf.set(this.rest);
    buf.set(chunk, this.rest.length);
    const width = this.from / DICTATION_SAMPLE_RATE;
    const out = new Int16Array(Math.floor(buf.length / width) + 1);
    let n = 0;
    let s = this.edge(this.k);
    for (let e = this.edge(this.k + 1); e <= buf.length; ) {
      let sum = 0;
      for (let i = Math.floor(s); i < e; i++) {
        sum += buf[i]! * (Math.min(e, i + 1) - Math.max(s, i));
      }
      out[n++] = toInt16(sum / (e - s));
      this.k++;
      s = e;
      e = this.edge(this.k + 1);
    }
    const kept = Math.floor(s);
    this.rest = buf.slice(kept);
    this.offset += kept;
    return out.subarray(0, n);
  }
}

export function toInt16(v: number): number {
  const c = Math.max(-1, Math.min(1, v));
  return Math.round(c < 0 ? c * 0x8000 : c * 0x7fff);
}

// the canonical 44-byte header and the samples little-endian: the one
// shape POST /api/transcribe takes
export function wavOf(chunks: readonly Int16Array[]): Uint8Array {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const dataBytes = samples * 2;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const v = new DataView(out.buffer);
  const ascii = (at: number, word: string) => {
    for (let i = 0; i < word.length; i++) out[at + i] = word.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, DICTATION_CHANNELS, true);
  v.setUint32(24, DICTATION_SAMPLE_RATE, true);
  v.setUint32(28, DICTATION_BYTES_PER_SECOND, true);
  v.setUint16(32, (DICTATION_CHANNELS * DICTATION_BITS) / 8, true);
  v.setUint16(34, DICTATION_BITS, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  let at = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    for (const s of chunk) {
      v.setInt16(at, s, true);
      at += 2;
    }
  }
  return out;
}

// how loud a chunk is, 0 to 1 over the 60 dB below full scale where
// speech sits, so a quiet room draws a flat line and a word a bar
export function levelOf(chunk: Float32Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (const v of chunk) sum += v * v;
  const rms = Math.sqrt(sum / chunk.length);
  if (rms <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60));
}

// "0:07", "4:59"
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The words go where the cursor was at the tap, while the draft is still
// what it was then; a draft changed since takes them at its end. A space
// goes before them unless the text before is empty, ends in one, or
// opens a bracket or a quote, and after them when a word follows
// straight on. A straight quote opens when nothing but space or a
// bracket is before it.
const OPENED = /(?:\s|[([{“‘«]|(?:^|[\s([{])["'])$/u;

export function insertText(
  draft: string,
  tap: { text: string; cursor: number },
  words: string,
): { text: string; cursor: number } {
  if (words === "") return { text: draft, cursor: draft.length };
  const at =
    draft === tap.text
      ? Math.max(0, Math.min(tap.cursor, draft.length))
      : draft.length;
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before === "" || OPENED.test(before) ? "" : " ";
  const trail = /^[\p{L}\p{N}]/u.test(after) ? " " : "";
  const head = `${before}${lead}${words}`;
  return { text: `${head}${trail}${after}`, cursor: head.length };
}

// the browser's refusal of the microphone, by the DOMException's name
export function captureLine(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Dictation: blocked in the browser";
  }
  return "Dictation: no microphone";
}

// the route's refusal, by its status; anything else failed on the way
export function transcribeLine(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 404) return "Dictation is off";
  if (status === 429) return "Dictation: too many clips, try later";
  if (status === 409) return "Dictation: a clip is already being transcribed";
  return "Dictation: transcription failed";
}
