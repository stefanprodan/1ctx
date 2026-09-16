// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's foot, in the composer's place: nobody writes into a run, so
// it holds the run's state, with its clock and Stop while it runs, for
// anyone who sees it. The words are the stream row's.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { StreamRow } from "../../../shared/api/sessions.ts";
import { count, reason } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { stateLine, whenText } from "../../stream/Row.model.ts";
import { durationOf, durationText } from "../projects/Automations.model.ts";

export function RunFoot({
  row,
  onStop,
}: {
  row: StreamRow;
  onStop: () => Promise<void>;
}) {
  const now = useSignal(Date.now());
  const failure = useSignal<string | null>(null);
  const running = row.session.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  }, [running, now]);
  // a done row's line is the answer's first line, which the transcript
  // above already shows; the foot says how long it took and what it cost
  const took = durationOf(row, now.value);
  const text = running
    ? `${stateLine(row).text} · ${whenText(row, now.value)}`
    : row.session.status === "done"
      ? [
          took === null ? "done" : `done in ${durationText(took)}`,
          ...(row.send === null || row.send.tokens === 0
            ? []
            : [`${count(row.send.tokens)} tokens`]),
        ].join(" · ")
      : stateLine(row).text;
  return (
    <div class="chat-run-foot">
      <Icon
        name="clock"
        size={14}
        class={`chat-run-icon chat-run-icon-${row.session.status}`}
      />
      <span class="chat-run-state">{text}</span>
      {failure.value !== null && (
        <span class="chat-run-failure error">{failure.value}</span>
      )}
      {running && (
        <button
          type="button"
          class="btn btn-small chat-run-stop"
          onClick={() => {
            failure.value = null;
            onStop().catch((err) => {
              failure.value = reason(err);
            });
          }}
        >
          <Icon name="stop" size={12} />
          Stop
        </button>
      )}
    </div>
  );
}
