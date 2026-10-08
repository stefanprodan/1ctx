// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fold's work rounds: each round's reasoning and the words before its
// calls under one thinking line, then its calls. The work fold and a
// subagent's group draw their rounds alike; the caller draws each call.

import type { JSX } from "preact";
import type { CallNode, WorkRound } from "./rows.ts";
import type { Live } from "./stream.ts";
import { Think } from "./Think.tsx";

export function Rounds({
  rounds,
  live,
  running,
  call,
}: {
  rounds: WorkRound[];
  live: ReadonlyMap<string, Live>;
  running: boolean;
  call: (node: CallNode) => JSX.Element;
}) {
  return (
    <>
      {rounds.map((round) => {
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
            <div class="transcript-work-calls">{round.calls.map(call)}</div>
          </div>
        );
      })}
    </>
  );
}
