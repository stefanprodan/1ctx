// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One run on an automation's Runs tab: how it started, when, the
// answer's first line, marked after the agent when the default
// decider judged it to need a person, and how long it took against its deadline, with
// Stop while it runs.

import { useSignal } from "@preact/signals";
import type { StreamRow } from "../../../shared/api/sessions.ts";
import { DEFERRED_BY_RESTART } from "../../../shared/words.ts";
import { stopSession } from "../../data/sessions.ts";
import { says, stamp } from "../../lib/format.ts";
import { runHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import {
  ATTENTION_WORDS,
  authorGone,
  needsAttention,
  stateLine,
  whenText,
} from "../../stream/Row.model.ts";
import {
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
  sourceIcon,
  sourceText,
} from "./Run.model.ts";
import "./automations.css";

export function RunRow({
  row,
  deadlineMs,
  now,
  deferred = false,
}: {
  row: StreamRow;
  deadlineMs: number;
  now: number;
  // the automation's last run, which a restart deferred
  deferred?: boolean;
}) {
  const failure = useSignal<string | null>(null);
  const { session } = row;
  const running = session.status === "running";
  const attention = needsAttention(session);
  const line = stateLine(row);
  const took = durationOf(row, now);
  const share = took === null ? 0 : deadlineShare(took, deadlineMs);
  return (
    <RowsGo
      href={runHref(session.id)}
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
      <span
        class="automations-run-icon"
        title={
          [
            sourceText(row),
            // a restart run says so alone
            deferred && session.runSource !== "restart"
              ? DEFERRED_BY_RESTART
              : "",
          ]
            .filter((part) => part !== "")
            .join(", ") || undefined
        }
      >
        <Icon
          name={sourceIcon(session)}
          size={15}
          class={attention ? "status-attention" : `status-${session.status}`}
        />
      </span>
      <RowsTitle
        name={stamp(row.send?.startedAt ?? session.createdAt)}
        sub={
          <>
            {line.author !== null && (
              <>
                <RowsHandle
                  name={line.author}
                  gone={authorGone(row, line)}
                />{" "}
              </>
            )}
            {attention && (
              <>
                <span class="automations-attention">{ATTENTION_WORDS}</span>
                {line.text !== "" && " · "}
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
