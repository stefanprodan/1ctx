// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation's page. The brief reads as one sentence: when, in which
// zone, which agent is asked, then the instructions as the agent gets
// them, cut to a few lines. Suspend or Resume and Run now, which anyone
// in the project presses, and Edit for whoever may change it, sit over
// two tabs. Runs is a log: what started each run, when, the answer's
// first line, and how long it took against its deadline, with Stop while
// it runs. Memory is the automation's own note.
// The aside has the next fires, the tally of the kept runs and the
// setup. The words are Automations.model.ts and Schedule.model.ts.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import type { StreamRow } from "../../../shared/api/sessions.ts";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import type { RunFilter, SessionStatus } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import { navigate, path } from "../../app/router.ts";
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
import { longDate, says, stamp, until } from "../../lib/format.ts";
import { agentHref, userHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useCut } from "../../lib/resize.ts";
import { stateLine, whenText } from "../../stream/Row.model.ts";
import { Page } from "../../ui/Page.tsx";
import {
  RowsAvatar,
  RowsBad,
  RowsCard,
  RowsEnd,
  RowsFilters,
  RowsGo,
  RowsHandle,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
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

// a run's clock is lit by its status, as the feed's is; a stopped run
// stays faint
function runIcon(status: SessionStatus): string {
  return status === "stopped" ? "automations-faint" : `status-${status}`;
}

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
      <RowsMeta>
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
            <span class="automations-when">{whenText(row, now)}</span>
          )}
        </span>
      </RowsMeta>
    </RowsGo>
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
  const { el, open, long } = useCut<HTMLParagraphElement>([text]);
  return (
    <>
      <div class="automations-brief-text">
        <p
          ref={el}
          class={`automations-brief-body${open.value ? "" : " clamp"}`}
        >
          {text}
        </p>
      </div>
      <div class="automations-brief-foot">
        {foot}
        {long.value && (
          <button
            type="button"
            class="btn-text automations-more"
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

// Both tabs' routes name this one view, so a tab change keeps the page
// mounted: the brief, the aside and the runs stay while only the tab's
// content changes.
export function Automation({ params }: { params: Params }) {
  const id = params.id ?? "";
  const row = automations.value?.find((a) => a.id === id) ?? null;
  // the Memory tab is there only while the automation keeps its own note
  const memoryPath = path.value.endsWith("/memory");
  const tab = memoryPath && row?.ownMemory ? "memory" : "runs";
  useEffect(() => {
    if (memoryPath && row !== null && !row.ownMemory) {
      navigate(`/automations/${id}`, true);
    }
  }, [memoryPath, row?.ownMemory, id]);
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
          <section class="card automations-brief">
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
                row.suspendedAt !== null ? (
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
                ) : null
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
          <Tabs
            tabs={[
              {
                label: "Runs",
                href: `/automations/${id}`,
                ...(tally === null ? {} : { count: total }),
              },
              ...(row.ownMemory
                ? [
                    {
                      label: "Memory",
                      href: `/automations/${id}/memory`,
                      ...(memoryNote === null
                        ? {}
                        : { count: memoryNote.entries.length }),
                    },
                  ]
                : []),
            ]}
            active={
              tab === "runs"
                ? `/automations/${id}`
                : `/automations/${id}/memory`
            }
          />
          {tab === "memory" ? (
            <Note
              memory={memoryNote}
              memoryKey={noteKey}
              error={noteErrors.value.get(noteKey) ?? null}
              empty="No memory yet. The next run writes it."
            />
          ) : (
            <RowsCard
              label="Runs"
              action={
                <RowsFilters
                  label="Filter runs"
                  filters={FILTERS.map((f) => ({
                    label: f.label,
                    on: f.value === filter,
                    href: `/automations/${id}${
                      f.value === null ? "" : `?runs=${f.value}`
                    }`,
                  }))}
                />
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
          )}
        </Split>
      )}
    </Page>
  );
}
