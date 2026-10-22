// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { servesTranscription } from "../../../shared/contracts/dictation.ts";
import { count } from "../../lib/format.ts";

export const transcriptionProviders = <T extends { wire: string }>(
  rows: readonly T[],
): T[] => rows.filter((p) => servesTranscription(p.wire));

// OpenRouter prices a transcription model per second of audio, read in
// per million like every price; a thousand minutes is the unit people
// compare them in
export function dictationMeta(m: { promptPrice: number | null }): string {
  if (m.promptPrice === null) return "";
  if (m.promptPrice === 0) return "free";
  return `$${Number((m.promptPrice * 0.06).toPrecision(3))} per 1,000 minutes`;
}

export function dictationLine(on: boolean): string {
  return on
    ? "Allows users to dictate in the composer."
    : "The composer has no mic.";
}

export function modelLine(saved: boolean): string {
  return saved
    ? "This model turns what users say into text."
    : "Pick the model that turns what users say into text.";
}

// on with no model saved: the server refuses it too
export function switchCheck(on: boolean, saved: boolean): string | null {
  return on && !saved ? "Pick a model first" : null;
}

// the server's whole phrases, so a changed message changes these
const DICTATION_FIELDS: [RegExp, string][] = [
  [/^providerId must be /, "provider"],
  [/^no such provider$/, "provider"],
  [/ serves no transcription models$/, "provider"],
  [/^model must be /, "model"],
  [/ does not list .+ as a transcription model$/, "model"],
];

export function dictationFieldOf(message: string): string | undefined {
  return DICTATION_FIELDS.find(([words]) => words.test(message))?.[1];
}

// the audio the clips held, in minutes: a tenth under ten of them
export function audioMinutes(seconds: number): string {
  const minutes = seconds / 60;
  if (minutes < 10) return `${Math.round(minutes * 10) / 10} min`;
  return `${count(Math.round(minutes))} min`;
}
