// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation's page. The brief reads as one sentence: when, in which
// zone, which agent is asked, then the instructions as the agent gets
// them, cut to a few lines. Suspend or Resume and Run now, which anyone
// in the project presses, and Edit for whoever may change it, sit over
// the runs, which follow as a log: what started each, when, the answer's first line,
// and how long it took against its deadline, with Stop while it runs.
// The aside has the next fires, the tally of the kept runs and the
// setup. The words are Automations.model.ts and Schedule.model.ts.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { StreamRow } from "../../../shared/api/sessions.ts";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import type { RunFilter } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import {
  automationError,
  automationProject,
  automations,
  automationsError,
  closeRunsOf,
  loadPreview,
  preview,
  previewKey,
  runDeadlineMs,
  runs,
} from "../../data/automations.ts";
import { me } from "../../data/me.ts";
import { keyOf, noteErrors, notes } from "../../data/memory.ts";
import { project, projectError } from "../../data/projects.ts";
import { projectAgents, stopSession } from "../../data/sessions.ts";
import { longDate, reason, stamp, until } from "../../lib/format.ts";
import { agentHref, userHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { stateLine, whenText } from "../../stream/Row.model.ts";
import { Page } from "../../ui/Page.tsx";
import { RowsCard, RowsNote } from "../../ui/Rows.tsx";
import { AsideSection, Split } from "../../ui/Split.tsx";
import { Note } from "../memory/Note.tsx";
import { AutomationActions } from "./AutomationActions.tsx";
import {
  browserZone,
  canChange,
  deadlineShare,
  deadlineText,
  durationOf,
  durationText,
  eventNote,
  memoryWords,
  scheduleTitle,
  sourceText,
  suspendedText,
} from "./Automations.model.ts";
import { fireLabel } from "./Schedule.model.ts";
import "./automations.css";

const FILTERS: { value: RunFilter | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "failed", label: "Failed" },
  { value: "manual", label: "Manual" },
];

function RunRow({
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
    <div class="automations-run">
      <a class="automations-run-link" href={`/chat/${session.id}`}>
        <Icon
          name={session.runSource === "manual" ? "bolt" : "clock"}
          size={16}
          class={`automations-run-icon automations-icon-${session.status}`}
        />
        <span class="automations-run-when">
          <span>{stamp(row.send?.startedAt ?? session.createdAt)}</span>
          <span class="automations-faint">{sourceText(row)}</span>
        </span>
        <span
          class={`automations-run-said${
            session.status === "failed" ? " automations-bad" : ""
          }`}
        >
          {line.author !== null && (
            <span class="automations-agent">@{line.author} </span>
          )}
          {failure.value ?? line.text}
          {row.send?.memoryError != null && (
            <span class="automations-faint"> Memory not updated.</span>
          )}
        </span>
        <span class="automations-run-took">
          <span>{took === null ? "" : durationText(took)}</span>
          <span class="automations-bar" aria-hidden="true">
            <span
              class={`automations-bar-fill automations-bar-${session.status}`}
              style={{ width: `${Math.round(share * 100)}%` }}
            />
          </span>
        </span>
      </a>
      <span class="automations-run-end">
        {running ? (
          <button
            type="button"
            class="btn btn-small"
            onClick={() => {
              failure.value = null;
              stopSession(session.id).catch((err) => {
                failure.value = reason(err);
              });
            }}
          >
            <Icon name="stop" size={12} />
            Stop
          </button>
        ) : (
          <span class="automations-mono">{whenText(row, now)}</span>
        )}
      </span>
    </div>
  );
}

// the instructions cut to a few lines, with Show more once they run
// past them; measured again when the width moves the cut
function Instructions({
  text,
  foot,
}: {
  text: string;
  // the state line under the box, which Show more shares
  foot: ComponentChildren;
}) {
  const open = useSignal(false);
  const long = useSignal(false);
  const el = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (node === null) return;
    const measure = () => {
      if (!open.value) long.value = node.scrollHeight > node.clientHeight + 1;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, open, long]);
  return (
    <>
      <div class="automations-brief-text">
        <p
          ref={el}
          class={`automations-brief-body${
            open.value ? "" : " automations-brief-cut"
          }`}
        >
          {text}
        </p>
      </div>
      <div class="automations-brief-foot">
        {foot}
        {long.value && (
          <button
            type="button"
            class="automations-more"
            aria-expanded={open.value}
            onClick={() => {
              open.value = !open.value;
            }}
          >
            {open.value ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </>
  );
}

function NextRuns({ automation }: { automation: AutomationSummary }) {
  const key = previewKey(
    automation.projectId,
    automation.schedule,
    automation.tz,
  );
  const held = preview.value?.key === key ? preview.value : null;
  const now = Date.now();
  if (automation.suspendedAt !== null) {
    return <div class="split-line">Suspended</div>;
  }
  return (
    <>
      {(held?.fires ?? []).map((fire) => (
        <div key={fire} class="split-line automations-fire">
          <span>{fireLabel(fire, now, automation.tz)}</span>
          <span class="automations-faint">{until(fire, now)}</span>
        </div>
      ))}
      {held?.problem && <div class="split-line error">{held.problem}</div>}
      {automation.tz !== browserZone() && (
        <div class="split-line automations-faint">In {automation.tz}</div>
      )}
    </>
  );
}

export function Automation({ params }: { params: Params }) {
  const id = params.id ?? "";
  const row = automations.value?.find((a) => a.id === id) ?? null;
  const found = automationProject.value;
  const projectId = found?.id === id ? found.projectId : null;
  const shown =
    project.value !== null && project.value.id === projectId
      ? project.value
      : null;
  const agents = projectAgents.value;
  const limit = runDeadlineMs.value;
  const held = runs.value?.id === id ? runs.value : null;
  const failure = useSignal<string | null>(null);
  const now = useSignal(Date.now());
  const tick = held?.rows?.some((r) => r.session.status === "running")
    ? 1000
    : 30_000;
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, tick);
    return () => clearInterval(timer);
  }, [tick, now]);
  // the runs are this page's; once it goes, no frame moves them
  useEffect(() => () => closeRunsOf(id), [id]);
  const noteKey = keyOf(projectId ?? "", id);
  const memoryNote = notes.value.get(noteKey) ?? null;
  // the next fires move with the schedule, and past each fire
  useEffect(() => {
    if (row === null || row.suspendedAt !== null) return;
    void loadPreview(row.projectId, row.schedule, row.tz);
  }, [row?.projectId, row?.schedule, row?.tz, row?.nextAt, row?.suspendedAt]);

  // the list is in and the row is not: deleted since the page opened
  const gone =
    row === null &&
    projectId !== null &&
    automations.value !== null &&
    agents !== null;
  const error =
    automationError.value ??
    automationsError.value ??
    projectError.value ??
    (gone ? "This automation was deleted." : null);
  const ready = row !== null && shown !== null && agents !== null;
  const agent = agents?.find((a) => a.id === row?.agentId) ?? null;
  const deadlineMs = row?.deadlineMs ?? limit ?? 0;
  const filter = held?.filter ?? null;
  const tally = held?.tally ?? null;
  const total =
    tally === null
      ? 0
      : tally.done + tally.failed + tally.stopped + tally.running;
  const note = row === null ? null : eventNote(row, now.value);
  const editable =
    row !== null &&
    shown !== null &&
    canChange(row, me.value ?? null, shown.kind);
  return (
    <Page
      crumb={shown?.name ?? "Project"}
      crumbHref={
        projectId === null ? undefined : `/projects/${projectId}/automations`
      }
      title={row?.name ?? "Automation"}
      loading={!ready && error === null}
      error={error}
    >
      {ready && (
        <Split
          aside={
            <>
              <AsideSection label="Next runs">
                <NextRuns automation={row} />
              </AsideSection>
              <AsideSection label="History">
                {tally === null ? (
                  <div class="split-line">Loading</div>
                ) : (
                  <>
                    <div class="split-line">
                      {total} {total === 1 ? "run" : "runs"} ·{" "}
                      {row.retentionDays}{" "}
                      {row.retentionDays === 1 ? "day" : "days"} retention
                    </div>
                    <div class="split-line">
                      {[
                        tally.running > 0 ? `${tally.running} running` : null,
                        `${tally.done} done`,
                        `${tally.failed} failed`,
                        `${tally.stopped} stopped`,
                      ]
                        .filter((s) => s !== null)
                        .join(" · ")}
                    </div>
                  </>
                )}
              </AsideSection>
              <AsideSection label="Setup">
                <div class="split-line">
                  Deadline
                  <span class="split-strong">{deadlineText(deadlineMs)}</span>
                </div>
                <div class="split-line">
                  Owner
                  <a class="split-strong" href={userHref(row.ownerName)}>
                    @{row.ownerName}
                  </a>
                </div>
                <div class="split-line">
                  Created
                  <span class="split-strong">{longDate(row.createdAt)}</span>
                </div>
              </AsideSection>
            </>
          }
        >
          <section class="automations-brief">
            <p class="automations-brief-line">
              <span class="automations-strong">
                {scheduleTitle(row.schedule)}
              </span>
              , {row.tz},{" "}
              {agent ? (
                <a class="automations-agent" href={agentHref(agent.name)}>
                  @{agent.name}
                </a>
              ) : (
                <span class="automations-agent">a deleted agent</span>
              )}{" "}
              is asked:
            </p>
            <Instructions
              text={row.instructions}
              foot={
                <>
                  {memoryWords(row) !== null && (
                    <p class="automations-brief-next automations-faint">
                      {memoryWords(row)}
                    </p>
                  )}
                  {row.suspendedAt !== null ? (
                    <p class="automations-brief-next">
                      <Icon name="pause" size={14} />
                      {suspendedText(row, now.value)}
                    </p>
                  ) : row.nextAt !== null ? (
                    <p class="automations-brief-next">
                      <Icon name="arrow-right" size={14} />
                      Next run {fireLabel(row.nextAt, now.value, row.tz, true)},{" "}
                      {until(row.nextAt, now.value)}
                    </p>
                  ) : null}
                </>
              }
            />
          </section>
          {note !== null && <p class="automations-note">{note}</p>}
          <AutomationActions
            automation={row}
            editable={editable}
            onFailure={(text) => {
              failure.value = text;
            }}
          />
          {failure.value !== null && (
            <p class="automations-note error" role="alert">
              {failure.value}
            </p>
          )}
          {(row.ownMemory || (memoryNote?.entries.length ?? 0) > 0) && (
            <Note
              memory={memoryNote}
              memoryKey={noteKey}
              error={noteErrors.value.get(noteKey) ?? null}
              empty={
                row.ownMemory
                  ? "No memory yet. The next run writes it."
                  : "No memory."
              }
            />
          )}
          <RowsCard
            label="Runs"
            action={
              <nav class="automations-filters" aria-label="Filter runs">
                {FILTERS.map((f) => (
                  <a
                    key={f.label}
                    class={`automations-filter${
                      f.value === filter ? " automations-filter-on" : ""
                    }`}
                    aria-current={f.value === filter ? "page" : undefined}
                    href={`/automations/${id}${
                      f.value === null ? "" : `?runs=${f.value}`
                    }`}
                  >
                    {f.label}
                  </a>
                ))}
              </nav>
            }
          >
            {held === null || held.rows === null ? (
              <RowsNote>Loading</RowsNote>
            ) : held.rows.length === 0 ? (
              <RowsNote>
                {filter === "failed"
                  ? "No failed runs."
                  : filter === "manual"
                    ? "No manual runs."
                    : "No runs yet."}
              </RowsNote>
            ) : (
              held.rows.map((r) => (
                <RunRow
                  key={r.session.id}
                  row={r}
                  deadlineMs={deadlineMs}
                  now={now.value}
                />
              ))
            )}
          </RowsCard>
        </Split>
      )}
    </Page>
  );
}
