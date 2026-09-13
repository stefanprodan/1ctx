// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import type { WorkNode } from "./rows.ts";
import type { Live } from "./stream.ts";
import { tail } from "./stream.ts";
import { Think } from "./Think.tsx";
import { Tool } from "./Tool.tsx";
import { workSummary } from "./Work.model.ts";

const opened = signal<ReadonlySet<string>>(new Set());

export function Work({
  node,
  live,
}: {
  node: WorkNode;
  live: ReadonlyMap<string, Live>;
}) {
  const running =
    node.send?.status === "running" ||
    node.rounds.some((round) => live.has(round.message.id));
  const open = opened.value.has(node.sendId);
  const summary = workSummary(node, running);

  // the fold opens as the send starts working and shuts when the send
  // ends; between the two the reader's own toggles are kept
  useEffect(() => {
    if (running === opened.value.has(node.sendId)) return;
    const next = new Set(opened.value);
    if (running) next.add(node.sendId);
    else next.delete(node.sendId);
    opened.value = next;
  }, [node.sendId, running]);

  return (
    <details
      class={`transcript-work${running ? " transcript-work-live" : ""}${
        open ? " transcript-work-open" : ""
      }`}
      open={open}
      onToggle={(event) => {
        const next = new Set(opened.value);
        if (event.currentTarget.open) next.add(node.sendId);
        else next.delete(node.sendId);
        opened.value = next;
      }}
    >
      <summary class="transcript-work-head">
        <Icon name="spinner" size={13} class="transcript-work-spin" />
        <Icon name="chevron-right" size={13} class="transcript-work-chevron" />
        <span>{summary.text}</span>
      </summary>
      <div class="transcript-work-rounds">
        {node.rounds.map((round) => {
          const current = live.get(round.message.id) ?? null;
          const reasoning = current?.reasoning ?? round.message.reasoning;
          const content = current?.content ?? round.message.content;
          const html = current?.html ?? round.message.html;
          return (
            <div class="transcript-work-round" key={round.message.id}>
              {reasoning !== "" && (
                <Think message={round.message} live={current} />
              )}
              {html !== "" && (
                // render/ produces this HTML with raw HTML disabled
                <div
                  class="transcript-work-text"
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              )}
              {current !== null && content !== "" && (
                <div class="transcript-work-tail">
                  {tail(current)}
                  <span class="transcript-work-cursor" aria-hidden="true" />
                </div>
              )}
              {current === null && html === "" && content.trim() !== "" && (
                <div class="transcript-work-plain">{content}</div>
              )}
              <div class="transcript-work-calls">
                {round.calls.map((call) => (
                  <Tool key={call.key} node={call} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
