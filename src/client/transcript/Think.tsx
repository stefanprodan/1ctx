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

import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Message } from "../../shared/contracts/session.ts";
import { Icon } from "../lib/icons.tsx";
import { type Live, liveOf, thinkParts } from "./stream.ts";

const opened = signal<ReadonlySet<string>>(new Set());

export function Think({
  message,
  live,
  children,
}: {
  message: Message;
  live: Live | null;
  children?: ComponentChildren;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (live === null) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [live]);
  const v = live ?? liveOf(message);
  const reasoning = live?.reasoning ?? message.reasoning;
  const streaming = live !== null;
  const open = opened.value.has(message.id);
  const { word, time } = thinkParts(v, live === null, Date.now());
  return (
    <details
      class={`transcript-think${streaming ? " transcript-think-live" : ""}${
        open ? " transcript-think-open" : ""
      }`}
      open={open}
      onToggle={(e) => {
        const next = new Set(opened.value);
        if (e.currentTarget.open) next.add(message.id);
        else next.delete(message.id);
        opened.value = next;
      }}
    >
      <summary class="transcript-think-head">
        <Icon name="spinner" size={12} class="transcript-think-spin" />
        <Icon name="chevron-right" size={12} class="transcript-think-chevron" />
        <span class="transcript-think-word">{word}</span>
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
