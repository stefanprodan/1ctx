// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's foot, in the composer's place: nobody writes into a run, so
// it holds the run's state, with its clock and Stop while it runs, for
// anyone who sees it. The words are the stream row's. Once the run is
// done or stopped the foot offers Fork, the turn's button, which lists
// the project's agents over it and makes a chat from the whole run. An
// archived chat's foot is the same: the archive icon, why it was
// archived and until when, and Fork from its last turn.

import { useSignal } from "@preact/signals";
import type { StreamRow } from "../../../shared/api/sessions.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { count, says } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { stateLine, whenText } from "../../stream/Row.model.ts";
import { ForkButton, type OnFork } from "../../transcript/Fork.tsx";
import { durationOf, durationText } from "../projects/Automations.model.ts";

export function RunFoot({
  row,
  archived,
  onStop,
  fork,
}: {
  row: StreamRow;
  // an archived chat's line, in place of the run's state
  archived?: string;
  onStop: () => Promise<void>;
  // the project's agents and the fork from the last turn; absent while
  // there is no answer to fork
  fork?: {
    agents: AgentSummary[];
    agentId: string;
    messageId: string;
    onFork: OnFork;
  };
}) {
  const failure = useSignal<string | null>(null);
  const running = row.session.status === "running";
  const forkable =
    fork !== undefined &&
    !running &&
    (archived !== undefined ||
      row.session.status === "done" ||
      row.session.status === "stopped");
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
      {archived === undefined ? (
        <Icon
          name="clock"
          size={14}
          class={`chat-run-icon status-${row.session.status}`}
        />
      ) : (
        // archived is no status: the icon stays quiet
        <Icon
          name="archive"
          size={14}
          class="chat-run-icon chat-run-archived"
        />
      )}
      {archived === undefined ? (
        <span
          class={`chat-run-state cut${row.session.status === "failed" ? " error" : ""}`}
        >
          {text}
        </span>
      ) : (
        <span class="chat-run-state">{archived}</span>
      )}
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
          <ForkButton
            messageId={fork.messageId}
            agents={fork.agents}
            agentId={fork.agentId}
            onFork={fork.onFork}
            foot
          />
        </div>
      )}
    </div>
  );
}
