// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The work before a send's answer (reasoning, what the model said
// between calls, the calls and their results) in one fold under the
// agent's line; every turn has it, tools or not. It stays shut behind
// one word while the send runs, opens on a click, and settles shut
// when the send ends, whether or
// not the reader opened it. The answer's own reasoning is in the
// fold too, as its last item.

import { useEffect, useRef } from "preact/hooks";
import type { Message } from "../../shared/contracts/session.ts";
import { Icon } from "../lib/icons.tsx";
import { folds, useTick } from "./fold.ts";
import type { WorkNode } from "./rows.ts";
import { type Live, leadIn } from "./stream.ts";
import { Think } from "./Think.tsx";
import { Tool } from "./Tool.tsx";
import { memorySummary, workJustEnded, workSummary } from "./Work.model.ts";

const { useFoldOpen, shut } = folds();

export function Work({
  node,
  reply,
  live,
  running,
  memory = false,
}: {
  node: WorkNode;
  // the answer, or the reply streaming after the work
  reply: Message | null;
  live: ReadonlyMap<string, Live>;
  running: boolean;
  // the run's memory phase, folded after the answer
  memory?: boolean;
}) {
  const foldKey = memory ? `${node.sendId}:memory` : node.sendId;
  const { open, onToggle } = useFoldOpen(foldKey);
  useTick(running);
  const summary = memory
    ? memorySummary(node, running, Date.now())
    : workSummary(node, running, Date.now());
  const wasRunning = useRef(running);

  // only the transition shuts the fold: mounting a finished send must
  // preserve a reader's choice from an earlier view
  useEffect(() => {
    const ended = workJustEnded(wasRunning.current, running);
    wasRunning.current = running;
    if (ended) shut(foldKey);
  }, [foldKey, running]);

  const replyLive =
    running && reply !== null ? (live.get(reply.id) ?? null) : null;
  const replyReasoning = replyLive?.reasoning ?? reply?.reasoning ?? "";
  // the reply's words while they may still be a work round's, the ones
  // Reply leaves out
  const replyLead =
    replyLive !== null &&
    reply?.slot === null &&
    leadIn(replyLive.content) &&
    replyLive.content.trim() !== ""
      ? replyLive.content
      : "";

  return (
    <details
      class={`transcript-fold transcript-work${
        running ? " transcript-fold-live" : ""
      }${open ? " transcript-fold-open" : ""}`}
      open={open}
      onToggle={onToggle}
    >
      <summary class="transcript-fold-head">
        <Icon name="spinner" size={13} class="transcript-fold-spin" />
        <Icon name="chevron-right" size={13} class="transcript-fold-chevron" />
        <span>{summary.text}</span>
      </summary>
      <div class="transcript-work-rounds">
        {node.rounds.map((round) => {
          const current = running ? (live.get(round.message.id) ?? null) : null;
          const reasoning = current?.reasoning ?? round.message.reasoning;
          const content = current?.content ?? round.message.content;
          const said = content.trim() !== "";
          return (
            <div class="transcript-work-round" key={round.message.id}>
              {(reasoning !== "" || said) && (
                <Think message={round.message} live={current}>
                  {said && (
                    // the words before a call are the model talking to
                    // itself: plain text like the reasoning, never markdown
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
        {reply !== null && (replyReasoning !== "" || replyLead !== "") && (
          <div class="transcript-work-round">
            <Think message={reply} live={replyLive}>
              {replyLead !== "" && (
                <div class="transcript-work-plain">{replyLead}</div>
              )}
            </Think>
          </div>
        )}
      </div>
    </details>
  );
}
