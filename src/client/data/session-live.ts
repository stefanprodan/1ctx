// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The replies streaming on the chat on screen. A burst of frames lands
// in one map ahead of the signal, published once per animation frame,
// so the transcript draws a streaming reply at most once per paint.
// Every reader in the data layer goes through ahead(), so a frame is
// never applied to a stale copy.

import { signal } from "@preact/signals";
import type { Live } from "../transcript/stream.ts";

type LiveMap = ReadonlyMap<string, Live>;

// runs a callback before the next paint
export type Frames = (draw: () => void) => void;

// with no animation frames (a test, a worker) a map is published at
// once; a hidden tab pauses them, and since the map ahead replaces
// itself rather than queueing, nothing piles up until the tab is shown
const nextFrame: Frames = (draw) => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(draw);
  } else draw();
};

export const live = signal<LiveMap>(new Map());

let frames: Frames = nextFrame;
let staged: Map<string, Live> | null = null;
let scheduled = false;

// a test's scheduler; null puts the browser's back
export function setFrames(next: Frames | null): void {
  frames = next ?? nextFrame;
  // a frame the old scheduler never ran must not hold back the next
  scheduled = false;
}

// the newest map, published or not
export const ahead = (): LiveMap => staged ?? live.value;

// one reply moved on a copy only the stream writes until it is published
export function stage(id: string, reply: Live): void {
  staged ??= new Map(live.value);
  staged.set(id, reply);
  if (!scheduled) {
    scheduled = true;
    frames(() => {
      scheduled = false;
      flushLive();
    });
  }
}

export function flushLive(): void {
  if (staged === null) return;
  const map = staged;
  staged = null;
  live.value = map;
}

// a map built from ahead() replaces the staged one, which it includes
export function publish(map: LiveMap): void {
  staged = null;
  live.value = map;
}
