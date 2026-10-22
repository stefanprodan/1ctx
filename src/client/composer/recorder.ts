// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One composer's recorder, apart from the view so a test drives it with
// a fake capture: start, the chunks as they land, stop, cancel, and the
// device going away. A clip that stops is sent and lands through
// landing.ts, wherever its chat is shown then.

import { signal } from "@preact/signals";
import { DICTATION_SAMPLE_RATE } from "../../shared/contracts/dictation.ts";
import { transcribe } from "../data/dictation.ts";
import { type Pending, startCapture } from "./capture.ts";
import {
  captureLine,
  Downsampler,
  levelOf,
  MAX_SAMPLES,
  MIN_SAMPLES,
  NO_WORDS,
  transcribeLine,
  wavOf,
} from "./dictation.ts";
import {
  landFailure,
  landWords,
  markTranscribing,
  type Tap,
} from "./landing.ts";

// enough bars to fill the widest composer; a narrow one clips the oldest
export const BARS = 160;

export type Phase = "idle" | "starting" | "recording";

// one recording: its chunks at 16 kHz, and the draft it started from
type Take = {
  key: string;
  tap: Tap;
  pending: Pending | null;
  down: Downsampler | null;
  chunks: Int16Array[];
  total: number;
};

// the clip's words, or why there are none; the key's box takes either
export async function sendClip(
  key: string,
  tap: Tap,
  chunks: readonly Int16Array[],
  call: (wav: Uint8Array) => Promise<string> = transcribe,
): Promise<void> {
  markTranscribing(key, true);
  try {
    const words = await call(wavOf(chunks));
    if (words.trim() === "") landFailure(key, NO_WORDS);
    else landWords(key, tap, words);
  } catch (err) {
    landFailure(key, transcribeLine(err));
  } finally {
    markTranscribing(key, false);
  }
}

export class Recorder {
  readonly phase = signal<Phase>("idle");
  readonly levels = signal<readonly number[]>([]);
  readonly seconds = signal(0);
  // bumped by every start, stop and drop, so a late answer of the
  // browser or a late chunk finds itself stale
  private turn = 0;
  private take: Take | null = null;

  constructor(
    private readonly capture: typeof startCapture = startCapture,
    private readonly send: typeof sendClip = sendClip,
  ) {}

  // from the tap until the clip is stopped or dropped; a send of the
  // draft waits meanwhile
  busy(): boolean {
    return this.phase.peek() !== "idle";
  }

  // inside the tap's gesture: startCapture makes and resumes the context
  // before it awaits anything
  start(key: string, tap: Tap, fail: (line: string) => void): void {
    if (this.phase.value !== "idle") return;
    const mine = ++this.turn;
    const t: Take = {
      key,
      tap,
      pending: null,
      down: null,
      chunks: [],
      total: 0,
    };
    this.take = t;
    this.levels.value = [];
    this.seconds.value = 0;
    this.phase.value = "starting";
    try {
      t.pending = this.capture(
        (frames) => this.chunk(mine, frames),
        () => this.ended(mine),
      );
    } catch (err) {
      // a browser that throws in the tap (no AudioContext): nothing to
      // cancel, startCapture closed what it made
      this.take = null;
      this.phase.value = "idle";
      fail(captureLine(err));
      return;
    }
    t.pending.ready.then(
      (capture) => {
        if (this.turn !== mine) return;
        t.down = new Downsampler(capture.rate);
        this.phase.value = "recording";
      },
      (err: unknown) => {
        if (this.turn !== mine) return;
        this.take = null;
        this.phase.value = "idle";
        fail(captureLine(err));
      },
    );
  }

  // a clip under MIN_SAMPLES goes without a word
  stop(): void {
    const t = this.take;
    if (this.phase.value !== "recording" || t === null) return;
    this.drop();
    if (t.total >= MIN_SAMPLES) void this.send(t.key, t.tap, t.chunks);
  }

  // the clip goes, the microphone and the context at once, at any phase
  drop(): void {
    this.turn++;
    this.take?.pending?.cancel();
    this.take = null;
    this.phase.value = "idle";
  }

  private chunk(mine: number, frames: Float32Array): void {
    const t = this.take;
    if (this.turn !== mine || t === null || t.down === null) return;
    const bars = this.levels.value;
    this.levels.value = [
      ...bars.slice(bars.length + 1 - BARS),
      levelOf(frames),
    ];
    const out = t.down.push(frames);
    const room = MAX_SAMPLES - t.total;
    t.chunks.push(out.length > room ? out.slice(0, room) : out);
    t.total += Math.min(out.length, room);
    this.seconds.value = Math.floor(t.total / DICTATION_SAMPLE_RATE);
    if (t.total >= MAX_SAMPLES) this.stop();
  }

  // the device went or the context was interrupted: what was heard is
  // sent, as on Stop; before the graph was up there is nothing to send
  private ended(mine: number): void {
    if (this.turn !== mine) return;
    if (this.phase.value === "recording") this.stop();
    else this.drop();
  }
}
