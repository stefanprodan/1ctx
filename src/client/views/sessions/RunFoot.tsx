// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's foot, in the composer's place: nobody writes into a run, so
// it holds the run's state, with its clock and Stop while it runs, for
// anyone who sees it. It is one card. A run that needs attention has
// the strip with why on top, and Dismiss while the run is one of its
// automation's open alert; under it the bar names the automation as
// a link, since the line over the transcript scrolls away in a long
// run, then the state in the feed row's words, the icon in the run's
// own status colour, as the strip carries the mark. On a phone only
// the name gives way, and the state's rest waits for a wide screen.
// Once the run is done or stopped the bar offers Fork, the turn's
// button, which lists the project's agents over it and makes a chat
// from the whole run. An archived chat's foot is the same card with no
// strip: the archive icon, why it was archived and until when, and
// Fork from its last turn.

import { useSignal } from "@preact/signals";
import type { FeedRow } from "../../../shared/api/sessions.ts";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import { needsAttention } from "../../feed/Row.model.ts";
import { says } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { ForkButton, type OnFork } from "../../transcript/Fork.tsx";
import { AttentionStrip } from "./AttentionStrip.tsx";
import { footState, type RunOf } from "./RunFoot.model.ts";

export function RunFoot({
  row,
  runOf,
  archived,
  onStop,
  onDismiss,
  fork,
}: {
  row: FeedRow;
  // the automation the run is of; absent on an archived chat's foot
  runOf?: RunOf;
  // an archived chat's line, in place of the run's state
  archived?: string;
  onStop: () => Promise<void>;
  // closes the automation's open alert; set while the run is one of it
  onDismiss?: () => Promise<unknown>;
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
  const { session } = row;
  const running = session.status === "running";
  const forkable =
    fork !== undefined &&
    !running &&
    (archived !== undefined ||
      session.status === "done" ||
      session.status === "stopped");
  const now = useNow(running ? 1000 : null);
  const state = footState(row, now);
  const bad = session.status === "failed" ? " error" : "";
  return (
    <div class="card chat-run-box">
      {archived === undefined && needsAttention(session) && (
        // a new run starts closed
        <AttentionStrip
          key={session.id}
          reason={session.attentionReason}
          by={
            session.attentionSource === "decider" ? session.attentionBy : null
          }
          onDismiss={
            onDismiss === undefined
              ? undefined
              : () => {
                  failure.value = null;
                  onDismiss().catch((err) => {
                    failure.value = says(err);
                  });
                }
          }
        />
      )}
      <div class="chat-run-foot">
        {archived === undefined ? (
          <Icon
            name="clock"
            size={14}
            class={`chat-run-icon status-${session.status}`}
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
          <span class="chat-run-line">
            {runOf !== undefined && (
              <>
                <span class="chat-run-of">Run of</span>
                {runOf.href === null ? (
                  // plain words, cut only where they do not fit
                  <span class="chat-run-words cut">{runOf.name}</span>
                ) : (
                  <a class="chat-run-link chat-run-name cut" href={runOf.href}>
                    {runOf.name}
                  </a>
                )}
              </>
            )}
            <span class={`chat-run-state${bad}`}>
              {runOf !== undefined && " · "}
              {state.main}
            </span>
            {state.more !== null && (
              <span class={`chat-run-more cut${bad}`}>
                {" · "}
                {state.more}
              </span>
            )}
          </span>
        ) : (
          <span class="chat-run-archived-line">{archived}</span>
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
    </div>
  );
}
