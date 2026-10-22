// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Dictation: a clip recorded in the composer, transcribed on the server by
// the model an admin picked, and put in the draft as text. The clip is
// a plain WAV the browser writes itself, so the server checks a fixed
// header and never decodes a container.

// the wires whose servers transcribe speech at
// <baseUrl>/audio/transcriptions: OpenRouter and mlx-serve
export const TRANSCRIPTION_WIRES = ["openrouter", "openai-compatible"] as const;
export function servesTranscription(wire: string): boolean {
  return (TRANSCRIPTION_WIRES as readonly string[]).includes(wire);
}

// the one format a clip may take: 16-bit PCM, mono, 16 kHz
export const DICTATION_SAMPLE_RATE = 16_000;
export const DICTATION_CHANNELS = 1;
export const DICTATION_BITS = 16;
export const DICTATION_BYTES_PER_SECOND =
  (DICTATION_SAMPLE_RATE * DICTATION_CHANNELS * DICTATION_BITS) / 8;
// the canonical RIFF header: RIFF, WAVE, a 16-byte fmt chunk, data
export const WAV_HEADER_BYTES = 44;
// the composer stops at five minutes, 9.16 MiB; the route's cap is
// above it
export const DICTATION_MAX_SECONDS = 300;
export const DICTATION_MAX_BYTES = 10 * 1024 * 1024;
export const DICTATION_CONTENT_TYPE = "audio/wav";

// the model Dictation transcribes with, kept while it is off
export type DictationSettings = {
  providerId: string;
  model: string;
  updatedAt: number;
};
