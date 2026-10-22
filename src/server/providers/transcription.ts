// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Speech to text: one WAV clip posted as multipart to
// <base>/audio/transcriptions, the OpenAI shape OpenRouter and mlx-serve
// both answer. Never retried: a second try costs the clip again.

import { readStream } from "../lib/body.ts";
import { messageOf } from "../lib/errors.ts";
import { OPENROUTER_HEADERS } from "./openrouter.ts";
import { keyOf, noKeyFile, type ProviderDeps, scrubKey } from "./provider.ts";
import { ProviderRefusal } from "./refusal.ts";
import type { ProviderRow } from "./store.ts";
import { authHeaders, endpoint } from "./wires.ts";

// a slow model on five minutes of speech, and no longer than a user
// waits on a spinner
export const TRANSCRIBE_TIMEOUT_MS = 120_000;
// far past five minutes of text: what is dropped unread past it
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

export type TranscriptionRequest = { model: string; wav: Uint8Array };

export type Transcript = {
  // trimmed, every run of whitespace one space
  text: string;
  // USD where the provider said (OpenRouter's usage.cost), else null
  cost: number | null;
};

// the model's text as a draft takes it: Whisper opens with a space and
// leaves double ones
export const tidyTranscript = (text: string): string =>
  text.trim().replace(/\s+/g, " ");

export function parseTranscript(body: unknown): Transcript | null {
  const b = body as { text?: unknown; usage?: { cost?: unknown } } | null;
  if (typeof b?.text !== "string") return null;
  const cost = b.usage?.cost;
  return {
    text: tidyTranscript(b.text),
    cost:
      typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? cost
        : null,
  };
}

async function send(
  row: ProviderRow,
  deps: ProviderDeps,
  key: string | null,
  req: TranscriptionRequest,
  signal: AbortSignal,
): Promise<Transcript> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([req.wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
    "clip.wav",
  );
  form.append("model", req.model);
  form.append("response_format", "json");
  const res = await deps.fetcher(
    endpoint(row.baseUrl, "/audio/transcriptions"),
    {
      method: "POST",
      headers: {
        ...(row.wire === "openrouter" ? OPENROUTER_HEADERS : {}),
        ...authHeaders(row.wire, key),
      },
      body: form,
      signal,
    },
  );
  if (!res.ok) {
    // the body is the provider's words, which nothing here keeps
    // and is never awaited: a stalled cancel would outlast the deadline
    void res.body?.cancel().catch(() => {});
    throw new ProviderRefusal(`${row.name} answered ${res.status}`, res.status);
  }
  const bytes = await readStream(res.body, MAX_TRANSCRIPT_BYTES, signal);
  if (bytes === null) throw new Error("the transcript is too large");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${row.name} did not answer with JSON`);
  }
  const transcript = parseTranscript(body);
  if (transcript === null) throw new Error(`${row.name} answered no text`);
  return transcript;
}

// one request; a refusal is a ProviderRefusal, anything else an Error
// in our words with the key scrubbed
export async function requestTranscription(
  row: ProviderRow,
  deps: ProviderDeps,
  req: TranscriptionRequest,
  signal: AbortSignal,
): Promise<Transcript> {
  const key = keyOf(row, deps.secret);
  if (row.keyName !== null && key === null) throw new Error(noKeyFile(row));
  try {
    return await send(row, deps, key, req, signal);
  } catch (err) {
    if (err instanceof ProviderRefusal) throw err;
    if (signal.aborted) {
      const timeout =
        signal.reason instanceof DOMException &&
        signal.reason.name === "TimeoutError";
      throw new Error(
        timeout
          ? `${row.name} did not answer in time`
          : `the request to ${row.name} was stopped`,
      );
    }
    throw new Error(
      scrubKey(`${row.name} did not answer: ${messageOf(err)}`, key),
    );
  }
}
