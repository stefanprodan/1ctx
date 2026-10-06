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
import type { LiveRetry, Message } from "../../shared/contracts/session.ts";
import { Icon } from "../lib/icons.tsx";
import { isDelegate } from "./Delegate.model.ts";
import { Delegate } from "./Delegate.tsx";
import { folds, useTick } from "./fold.ts";
import { Rounds } from "./Rounds.tsx";
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
  marked = false,
  retry = null,
}: {
  node: WorkNode;
  // the answer, or the reply streaming after the work
  reply: Message | null;
  live: ReadonlyMap<string, Live>;
  running: boolean;
  // the rounds after a run's answer, its attention step and its memory
  // phase, folded as one
  memory?: boolean;
  // the run carries its agent's mark, which the memory fold says
  marked?: boolean;
  // the running round waiting to ask its provider again
  retry?: LiveRetry | null;
}) {
  const foldKey = memory ? `${node.sendId}:memory` : node.sendId;
  const { open, onToggle } = useFoldOpen(foldKey);
  useTick(running);
  const summary = memory
    ? memorySummary(node, running, Date.now(), retry, marked)
    : workSummary(node, running, Date.now(), retry);
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
        <Rounds
          rounds={node.rounds}
          live={live}
          running={running}
          call={(call) =>
            isDelegate(call) ? (
              <Delegate key={call.key} node={call} />
            ) : (
              <Tool key={call.key} node={call} />
            )
          }
        />
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
