// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The work before a send's answer (reasoning, what the model said
// between calls, the calls and their results) in one fold under the
// agent's line. It stays shut behind one word while the send runs,
// opens on a click, and settles shut when the send ends, whether or
// not the reader opened it. The answer's own reasoning is in the
// fold too, as its last item.

import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { Message } from "../../shared/contracts/session.ts";
import { Icon } from "../lib/icons.tsx";
import type { WorkNode } from "./rows.ts";
import type { Live } from "./stream.ts";
import { tail } from "./stream.ts";
import { Think } from "./Think.tsx";
import { Tool } from "./Tool.tsx";
import { workJustEnded, workSummary } from "./Work.model.ts";

const opened = signal<ReadonlySet<string>>(new Set());

export function Work({
  node,
  reply,
  live,
  running,
}: {
  node: WorkNode;
  // the answer, or the reply streaming after the work
  reply: Message | null;
  live: ReadonlyMap<string, Live>;
  running: boolean;
}) {
  const open = opened.value.has(node.sendId);
  const summary = workSummary(node, running);
  const wasRunning = useRef(running);

  // only the transition shuts the fold: mounting a finished send must
  // preserve a reader's choice from an earlier view
  useEffect(() => {
    const ended = workJustEnded(wasRunning.current, running);
    wasRunning.current = running;
    if (!ended || !opened.value.has(node.sendId)) return;
    const next = new Set(opened.value);
    next.delete(node.sendId);
    opened.value = next;
  }, [node.sendId, running]);

  const replyLive =
    running && reply !== null ? (live.get(reply.id) ?? null) : null;
  const replyReasoning = replyLive?.reasoning ?? reply?.reasoning ?? "";

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
          const current = running ? (live.get(round.message.id) ?? null) : null;
          const reasoning = current?.reasoning ?? round.message.reasoning;
          const content = current?.content ?? round.message.content;
          const html = current?.html ?? round.message.html;
          const said = content.trim() !== "";
          return (
            <div class="transcript-work-round" key={round.message.id}>
              {(reasoning !== "" || said) && (
                <Think message={round.message} live={current}>
                  {html !== "" && (
                    // render/ produces this HTML with raw HTML disabled
                    <div
                      class="transcript-work-text"
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  )}
                  {current !== null && said && (
                    <div class="transcript-work-tail">
                      {tail(current)}
                      <span class="transcript-work-cursor" aria-hidden="true" />
                    </div>
                  )}
                  {current === null && html === "" && said && (
                    <div class="transcript-work-plain">{content}</div>
                  )}
                </Think>
              )}
              <div class="transcript-work-calls">
                {round.calls.map((call) => (
                  <Tool key={call.key} node={call} />
                ))}
              </div>
            </div>
          );
        })}
        {reply !== null && replyReasoning !== "" && (
          <div class="transcript-work-round">
            <Think message={reply} live={replyLive} />
          </div>
        )}
      </div>
    </details>
  );
}
