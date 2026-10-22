// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Dictation: the admin's setting, and the transcription of a composer clip.
// A save or a flip of the switch also moves dictationOn, so the admin's own composer
// shows or hides its mic at once; other tabs learn it on their next load.

import { effect, signal } from "@preact/signals";
import type {
  DictationResponse,
  PatchDictationRequest,
  PutDictationRequest,
  TranscribeResponse,
} from "../../shared/api/dictation.ts";
import { DICTATION_CONTENT_TYPE } from "../../shared/contracts/dictation.ts";
import { type Failure, failure } from "../lib/format.ts";
import { ApiError, api, postBytes } from "./api.ts";
import { dictationTicket, landDictationOn, me } from "./me.ts";

export const dictation = signal<DictationResponse | null>(null);
export const dictationError = signal<Failure | null>(null);

let owner: string | null = null;
// the ticket (me.ts) of the answer shown: a read takes one when it asks,
// a write when it lands, so a read asked before a write lands never
// undoes it, and a write in flight never loses to a read
let shown = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  dictation.value = null;
  dictationError.value = null;
});

function settle(
  forUser: string | null,
  next: DictationResponse,
  asked = dictationTicket(),
) {
  if (owner !== forUser || asked <= shown) return;
  shown = asked;
  // a read that failed before this landed no longer stands
  dictationError.value = null;
  dictation.value = next;
  landDictationOn(next.enabled, asked);
}

export async function loadDictation(): Promise<void> {
  const forUser = owner;
  const asked = dictationTicket();
  dictationError.value = null;
  try {
    const next = await api<DictationResponse>("/api/admin/dictation");
    settle(forUser, next, asked);
  } catch (err) {
    if (owner === forUser && asked > shown) dictationError.value = failure(err);
  }
}

// the answer is the whole setting
export async function saveDictation(body: PutDictationRequest): Promise<void> {
  const forUser = owner;
  settle(
    forUser,
    await api<DictationResponse>("/api/admin/dictation", "PUT", body),
  );
}

export async function switchDictation(
  body: PatchDictationRequest,
): Promise<void> {
  const forUser = owner;
  settle(
    forUser,
    await api<DictationResponse>("/api/admin/dictation", "PATCH", body),
  );
}

// the clip's words; a 404 means Dictation went off since this tab loaded,
// so the mic goes too, unless a word newer than the clip's ask turned it
// on again
export async function transcribe(wav: Uint8Array): Promise<string> {
  const asked = dictationTicket();
  try {
    const body = await postBytes<TranscribeResponse>(
      "/api/transcribe",
      new Blob([wav as Uint8Array<ArrayBuffer>], {
        type: DICTATION_CONTENT_TYPE,
      }),
    );
    return body.text;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      landDictationOn(false, asked);
    }
    throw err;
  }
}
