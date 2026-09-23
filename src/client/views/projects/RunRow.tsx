// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One run on an automation's Runs tab: how it started, when, the
// answer's first line, and how long it took against its deadline, with
// Stop while it runs.

import { useSignal } from "@preact/signals";
import type { StreamRow } from "../../../shared/api/sessions.ts";
import type { SessionStatus } from "../../../shared/words.ts";
import { stopSession } from "../../data/sessions.ts";
import { says, stamp } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { stateLine, whenText } from "../../stream/Row.model.ts";
import {
  RowsAvatar,
  RowsBad,
  RowsEnd,
  RowsGo,
  RowsHandle,
  RowsMeta,
  RowsTitle,
} from "../../ui/Rows.tsx";
import {
  deadlineShare,
  durationOf,
  durationText,
  sourceText,
} from "./Automations.model.ts";
import "./automations.css";

// a run's clock is lit by its status, as the feed's is; a stopped run
// stays faint
function runIcon(status: SessionStatus): string {
  return status === "stopped" ? "automations-faint" : `status-${status}`;
}

export function RunRow({
  row,
  deadlineMs,
  now,
}: {
  row: StreamRow;
  deadlineMs: number;
  now: number;
}) {
  const failure = useSignal<string | null>(null);
  const { session } = row;
  const running = session.status === "running";
  const line = stateLine(row);
  const took = durationOf(row, now);
  const share = took === null ? 0 : deadlineShare(took, deadlineMs);
  return (
    <RowsGo
      href={`/chat/${session.id}`}
      end={
        running ? (
          <RowsEnd>
            <button
              type="button"
              class="btn btn-small"
              onClick={() => {
                failure.value = null;
                stopSession(session.id).catch((err) => {
                  failure.value = says(err);
                });
              }}
            >
              <Icon name="stop" size={12} />
              Stop
            </button>
          </RowsEnd>
        ) : undefined
      }
    >
      {/* the icon says how the run started, and who pressed Run now
          under the pointer, so the line is the feed's: author and words */}
      <RowsAvatar title={sourceText(row) || undefined}>
        <Icon
          name={session.runSource === "manual" ? "bolt" : "clock"}
          size={15}
          class={runIcon(session.status)}
        />
      </RowsAvatar>
      <RowsTitle
        name={stamp(row.send?.startedAt ?? session.createdAt)}
        sub={
          <>
            {line.author !== null && (
              <>
                <RowsHandle name={line.author} />{" "}
              </>
            )}
            {/* only the failure's words are red; who ran it keeps its colour */}
            {failure.value !== null || session.status === "failed" ? (
              <RowsBad>{failure.value ?? line.text}</RowsBad>
            ) : (
              line.text
            )}
            {row.send?.memoryError != null && " Memory not updated."}
            {row.send?.memorySkipped != null &&
              row.send.memorySkipped > 0 &&
              ` ${row.send.memorySkipped} edits no longer applied.`}
          </>
        }
      />
      <RowsMeta keep>
        <span class="automations-run-meta">
          <span class="automations-took">
            <span>{took === null ? "" : durationText(took)}</span>
            <span class="meter" aria-hidden="true">
              <span
                class={`meter-fill automations-bar-${session.status}`}
                style={{ width: `${Math.round(share * 100)}%` }}
              />
            </span>
          </span>
          {!running && (
            <span class="automations-ago">{whenText(row, now)}</span>
          )}
        </span>
      </RowsMeta>
    </RowsGo>
  );
}
