// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// POST /api/transcribe: the refusals that cost nothing come before the
// body is read, then the clip's header, then one provider call. Only a
// usage row is kept; the audio and the text are never stored or logged.

import type { TranscribeResponse } from "../../shared/api/dictation.ts";
import { DICTATION_MAX_BYTES } from "../../shared/contracts/dictation.ts";
import { readBytes } from "../lib/body.ts";
import { type Clock, HOUR_MS } from "../lib/clock.ts";
import {
  BadGateway,
  BadRequest,
  Conflict,
  checked,
  NotFound,
  TooManyRequests,
} from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import {
  failureFields,
  type Providers,
  TRANSCRIBE_TIMEOUT_MS,
} from "../providers/index.ts";
import type { DictationUsageFields } from "../usage/index.ts";
import { parseClipType } from "./parse.ts";
import type { DictationStore } from "./store.ts";
import { parseWav } from "./wav.ts";

export type ProvidersPort = Pick<Providers, "byId" | "model" | "transcribe">;

export type UsagePort = {
  recordDictation(fields: DictationUsageFields): void;
  dictationClipsSince(userId: string, since: number): number;
  dictationClipAt(userId: string, since: number, skip: number): number | null;
};

export type LimitsPort = { dictationClipsPerUser(): number };

export type TranscribeDeps = {
  store: DictationStore;
  providers: ProvidersPort;
  usage: UsagePort;
  limits: LimitsPort;
  clock: Clock;
  log: Log;
};

// the connection outlives the provider's deadline, with a minute for a
// slow phone's upload; Bun's default would drop it after 10 s
export const TRANSCRIBE_IDLE_SECONDS = TRANSCRIBE_TIMEOUT_MS / 1000 + 60;

export const DICTATION_OFF = "Dictation is off";
export const TOO_MANY_CLIPS = "too many clips, try later";
export const CLIP_RUNNING = "a clip is already being transcribed";
export const TRANSCRIPTION_FAILED = "transcription failed";

export function transcriber(deps: TranscribeDeps) {
  // a user's clip in flight, so a double tap never pays twice
  const running = new Set<string>();
  // the hourly cap, counted on the rows the user's clips left
  const capped = (userId: string) => {
    const now = deps.clock();
    const since = now - HOUR_MS;
    const clips = deps.usage.dictationClipsSince(userId, since);
    const limit = deps.limits.dictationClipsPerUser();
    if (clips < limit) return;
    // a lowered cap frees a place only once the count falls below it
    const at = deps.usage.dictationClipAt(userId, since, clips - limit);
    const frees = (at ?? now) + HOUR_MS - now;
    throw new TooManyRequests(
      TOO_MANY_CLIPS,
      Math.max(1, Math.ceil(frees / 1000)),
    );
  };
  return async (
    req: Request,
    principal: Principal,
  ): Promise<TranscribeResponse> => {
    const settings = deps.store.on() ? deps.store.settings() : null;
    const provider =
      settings === null ? null : deps.providers.byId(settings.providerId);
    if (settings === null || provider === null)
      throw new NotFound(DICTATION_OFF);
    capped(principal.userId);
    if (running.has(principal.userId)) throw new Conflict(CLIP_RUNNING);
    running.add(principal.userId);
    try {
      parseClipType(req.headers.get("content-type"));
      let wav: Uint8Array;
      try {
        wav = await readBytes(req, DICTATION_MAX_BYTES, req.signal);
      } catch (err) {
        // a tab closed during the upload is the client's stop, not a fault
        if (req.signal.aborted) throw new BadRequest("the clip was stopped");
        throw err;
      }
      const clip = checked(parseWav(wav));
      const fields = {
        provider: provider.name,
        model: settings.model,
        bytes: wav.byteLength,
        clip_ms: Math.round(clip.seconds * 1000),
      };
      let transcript: Awaited<ReturnType<ProvidersPort["transcribe"]>>;
      try {
        transcript = await deps.providers.transcribe(
          provider.id,
          { model: settings.model, wav },
          AbortSignal.any([
            req.signal,
            AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
          ]),
        );
      } catch (err) {
        if (req.signal.aborted) throw new BadRequest("the clip was stopped");
        deps.log.warn("transcription failed", {
          ...fields,
          ...failureFields(err),
        });
        throw new BadGateway(TRANSCRIPTION_FAILED);
      }
      deps.usage.recordDictation({
        userId: principal.userId,
        providerId: provider.id,
        providerName: provider.name,
        model: settings.model,
        seconds: clip.seconds,
        cost: transcript.cost,
        now: deps.clock(),
      });
      deps.log.info("clip transcribed", fields);
      return { text: transcript.text };
    } finally {
      running.delete(principal.userId);
    }
  };
}
