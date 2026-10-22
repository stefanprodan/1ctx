// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composer's mic: a tap records, the input line gives way to a
// live level line, the clock, cancel and stop, and stop sends the clip
// to be transcribed while the mic of its chat spins. The words land at
// the cursor the tap saw, in whichever box shows the clip's draft then
// (landing.ts). Nothing is sent on its own. Leaving the chat or the page
// while recording drops the clip and lets the microphone go; a clip
// already sent still lands. The device going away mid-clip is a stop.

import type { Signal } from "@preact/signals";
import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { dictationOn } from "../data/me.ts";
import { Icon } from "../lib/icons.tsx";
import { touch } from "../lib/touch.ts";
import { canRecord, clock, insertText } from "./dictation.ts";
import { writeDraftText } from "./draft.ts";
import { showDraft, transcribing } from "./landing.ts";
import { BARS, Recorder } from "./recorder.ts";
import "./dictation.css";

export type DictationBox = {
  key: string;
  text: Signal<string>;
  failure: Signal<string | null>;
};

export function useDictation(
  box: DictationBox,
  input: RefObject<HTMLTextAreaElement | null>,
  made: () => Recorder = () => new Recorder(),
) {
  const held = useRef<Recorder | null>(null);
  if (held.current === null) held.current = made();
  const rec = held.current;
  // where the cursor goes once the box shows the words
  const cursor = useRef<number | null>(null);
  // another chat or no composer: a recording goes, the microphone too,
  // and the box no longer shows this key's draft. A layout effect, so the
  // drop is in place before any tap: Preact skips a passive effect whose
  // component goes before it ran, and its cleanup with it
  const key = box.key;
  useLayoutEffect(() => {
    const release = showDraft(key, {
      insert: (tap, words) => {
        const next = insertText(box.text.value, tap, words);
        box.text.value = next.text;
        writeDraftText(key, next.text);
        box.failure.value = null;
        cursor.current = next.cursor;
      },
      fail: (line) => {
        box.failure.value = line;
      },
    });
    return () => {
      release();
      rec.drop();
    };
  }, [key]);
  useLayoutEffect(() => {
    const el = input.current;
    const at = cursor.current;
    if (el === null || at === null || el.value !== box.text.value) return;
    cursor.current = null;
    el.setSelectionRange(at, at);
    if (!touch()) el.focus();
  });

  // the cursor is saved now, since the strip hides the box
  const start = () => {
    const text = box.text.value;
    const cursorAt = input.current?.selectionStart ?? text.length;
    box.failure.value = null;
    rec.start(key, { text, cursor: cursorAt }, (line) => {
      box.failure.value = line;
    });
  };
  const cancel = () => {
    rec.drop();
    if (!touch()) input.current?.focus();
  };

  const phase = rec.phase.value;
  const recording = phase === "recording";
  // the spinner is the clip's chat's, wherever the user is now
  const sending = transcribing.value.has(key);
  const shown = sending || phase !== "idle" || dictationOn.value;
  return {
    recording,
    // read at the call, so a send in the same tick as the tap waits too
    busy: () => rec.busy(),
    strip: recording ? (
      <Strip
        levels={rec.levels}
        seconds={rec.seconds}
        onCancel={cancel}
        onStop={() => rec.stop()}
      />
    ) : null,
    mic:
      shown && !recording && canRecord(globalThis) ? (
        <Mic sending={sending} busy={phase !== "idle"} onTap={start} />
      ) : null,
  };
}

// beside Send, drawn as it is; it spins while a clip of its chat is
// transcribed
function Mic({
  sending,
  busy,
  onTap,
}: {
  sending: boolean;
  busy: boolean;
  onTap: () => void;
}) {
  const label = sending ? "Transcribing" : "Dictate";
  return (
    <button
      type="button"
      class="composer-send composer-mic"
      aria-label={label}
      title={label}
      disabled={sending || busy}
      onClick={onTap}
    >
      {sending ? (
        <Icon name="spinner" size={16} class="dictation-spin" />
      ) : (
        <Icon name="mic" size={16} />
      )}
    </button>
  );
}

// in the input line's place while recording; reads its own signals, so
// a chunk redraws the strip and not the composer
function Strip({
  levels,
  seconds,
  onCancel,
  onStop,
}: {
  levels: Signal<readonly number[]>;
  seconds: Signal<number>;
  onCancel: () => void;
  onStop: () => void;
}) {
  const bars = levels.value;
  return (
    <div class="dictation">
      <div class="dictation-level" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => {
          const level = bars[i - (BARS - bars.length)] ?? 0;
          return (
            <span
              key={i}
              class="dictation-bar"
              style={{ height: `${Math.round(8 + level * 92)}%` }}
            />
          );
        })}
      </div>
      <span class="dictation-time">{clock(seconds.value)}</span>
      <button
        type="button"
        class="btn-icon dictation-cancel"
        aria-label="Cancel recording"
        title="Cancel"
        onClick={onCancel}
      >
        <Icon name="close" size={16} />
      </button>
      <button
        type="button"
        class="dictation-stop"
        aria-label="Stop recording"
        title="Stop"
        onClick={onStop}
      >
        <Icon name="check" size={16} />
      </button>
    </div>
  );
}
