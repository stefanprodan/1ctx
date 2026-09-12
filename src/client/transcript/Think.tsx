// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The reasoning of a reply, folded under one line. While the reply
// streams the label counts this tab's clock every 250 ms; a finished
// row shows the runner's measurement. Whether a fold is open is kept
// per message for the life of the page, so a re-render never shuts it.

import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import type { Message } from "../../shared/contracts/session.ts";
import { Icon } from "../lib/icons.tsx";
import { type Live, liveOf, thinkLabel } from "./stream.ts";

const opened = signal<ReadonlySet<string>>(new Set());

export function Think({
  message,
  live,
}: {
  message: Message;
  live: Live | null;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (live === null) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [live]);
  const v = live ?? liveOf(message);
  const reasoning = live?.reasoning ?? message.reasoning;
  const streaming = live !== null && live.content === "";
  return (
    <details
      class={`transcript-think${streaming ? " transcript-think-live" : ""}`}
      open={opened.value.has(message.id)}
      onToggle={(e) => {
        const next = new Set(opened.value);
        if (e.currentTarget.open) next.add(message.id);
        else next.delete(message.id);
        opened.value = next;
      }}
    >
      <summary class="transcript-think-head">
        <span class="transcript-spin" aria-hidden="true" />
        <Icon name="chevron-right" size={12} class="transcript-think-chevron" />
        <span>{thinkLabel(v, live === null, Date.now())}</span>
      </summary>
      <div class="transcript-reasoning">{reasoning}</div>
    </details>
  );
}
