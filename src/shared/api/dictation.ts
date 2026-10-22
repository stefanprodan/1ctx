// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the Dictation routes: the settings for
// admins, the transcription for every signed-in user.

import type { DictationSettings } from "../contracts/dictation.ts";

// GET /api/admin/dictation, and what PUT and PATCH answer: settings null
// until a model is saved, kept while enabled is false
export type DictationResponse = {
  enabled: boolean;
  settings: DictationSettings | null;
};

// PUT /api/admin/dictation: a provider on a TRANSCRIPTION_WIRES wire and a
// model its transcription catalog lists, else a 400. A first save is off
export type PutDictationRequest = { providerId: string; model: string };

// PATCH /api/admin/dictation: the switch; on with no model saved is a 400
export type PatchDictationRequest = { enabled: boolean };

// POST /api/transcribe: the body is the clip, content-type audio/wav
// (DICTATION_* in contracts/dictation.ts). Answered with the text, trimmed and
// with runs of whitespace as one space. Refusals: 404 Dictation is off, 429
// the user's clips per hour, 409 a clip of theirs already in flight,
// 413 past DICTATION_MAX_BYTES, 400 not such a WAV, 502 the provider failed
export type TranscribeResponse = { text: string };
