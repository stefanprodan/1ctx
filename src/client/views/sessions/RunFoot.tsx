// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's foot, in the composer's place: nobody writes into a run, so
// it holds the run's state, with its clock and Stop while it runs, for
// anyone who sees it. The words are the stream row's. Once the run is
// done or stopped the foot offers the fork: the agent chip, the run's
// own at first, and Fork, which makes a chat from the run and opens it.

import { useSignal } from "@preact/signals";
import type { StreamRow } from "../../../shared/api/sessions.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { AgentPicker } from "../../composer/AgentPicker.tsx";
import { forking } from "../../data/fork.ts";
import { count, says } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { stateLine, whenText } from "../../stream/Row.model.ts";
import { durationOf, durationText } from "../projects/Automations.model.ts";

export function RunFoot({
  row,
  onStop,
  fork,
}: {
  row: StreamRow;
  onStop: () => Promise<void>;
  // the project's agents and the fork of the whole run; absent while
  // the run has no answer to fork
  fork?: { agents: AgentSummary[]; onFork: (agentId: string) => Promise<void> };
}) {
  const failure = useSignal<string | null>(null);
  const picked = useSignal(row.session.agentId);
  const running = row.session.status === "running";
  const forkable =
    fork !== undefined &&
    (row.session.status === "done" || row.session.status === "stopped");
  const now = useNow(running ? 1000 : null);
  // a done row's line is the answer's first line, which the transcript
  // above already shows; the foot says how long it took and what it cost
  const took = durationOf(row, now);
  const text = running
    ? `${stateLine(row).text} · ${whenText(row, now)}`
    : row.session.status === "done"
      ? [
          took === null ? "done" : `done in ${durationText(took)}`,
          ...(row.send === null || row.send.tokens === 0
            ? []
            : [`${count(row.send.tokens)} tokens`]),
        ].join(" · ")
      : stateLine(row).text;
  return (
    <div class="card chat-run-foot">
      <Icon
        name="clock"
        size={14}
        class={`chat-run-icon status-${row.session.status}`}
      />
      <span
        class={`chat-run-state cut${row.session.status === "failed" ? " error" : ""}`}
      >
        {text}
      </span>
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
              failure.value = says(err);
            });
          }}
        >
          <Icon name="stop" size={12} />
          Stop
        </button>
      )}
      {forkable && (
        <div class="chat-run-fork">
          <AgentPicker
            agents={fork.agents}
            agentId={picked.value}
            onPick={(id) => {
              picked.value = id;
            }}
          />
          <button
            type="button"
            class="btn btn-small"
            disabled={forking.value}
            onClick={() => {
              failure.value = null;
              fork.onFork(picked.value).catch((err) => {
                failure.value = says(err);
              });
            }}
          >
            <Icon name="fork" size={12} />
            Fork
          </button>
        </div>
      )}
    </div>
  );
}
