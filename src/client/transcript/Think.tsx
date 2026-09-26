// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The reasoning of a reply, folded under one line. While the reply
// streams the label counts this tab's clock every 250 ms; a finished
// row shows the runner's measurement. Whether a fold is open is kept
// per message for the life of the page, so a re-render never shuts it.
// A work round's text, what the model said before calling, is the
// model talking to itself and sits in the same fold, under the
// reasoning.

import type { ComponentChildren } from "preact";
import type { Message } from "../../shared/contracts/session.ts";
import { Icon } from "../lib/icons.tsx";
import { folds, useTick } from "./fold.ts";
import { type Live, liveOf, thinkTime } from "./stream.ts";

const { useFoldOpen } = folds();

export function Think({
  message,
  live,
  children,
}: {
  message: Message;
  live: Live | null;
  children?: ComponentChildren;
}) {
  useTick(live !== null);
  const v = live ?? liveOf(message);
  const reasoning = live?.reasoning ?? message.reasoning;
  const streaming = live !== null;
  const { open, onToggle } = useFoldOpen(message.id);
  const time = thinkTime(v, live === null, Date.now());
  return (
    <details
      class={`transcript-fold${streaming ? " transcript-fold-live" : ""}${
        open ? " transcript-fold-open" : ""
      }`}
      open={open}
      onToggle={onToggle}
    >
      <summary class="transcript-fold-head transcript-fold-small">
        <Icon name="spinner" size={12} class="transcript-fold-spin" />
        <Icon name="chevron-right" size={12} class="transcript-fold-chevron" />
        <span class="transcript-think-word">thinking</span>
        {time !== null && <span class="transcript-think-time">{time}</span>}
      </summary>
      <div class="transcript-think-body">
        {reasoning !== "" && (
          <div class="transcript-reasoning">{reasoning}</div>
        )}
        {children}
      </div>
    </details>
  );
}
