// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation's page. The brief reads as one sentence: when, in which
// zone, which agent is asked, then the instructions as the agent gets
// them, cut to a few lines. An automation whose agent was deleted names
// it with a tag and says it is paused until an edit picks another.
// Suspend or Resume and Run now, which anyone in the project presses,
// and Edit for whoever may change it, sit over two tabs. Runs is a log
// of RunRow.tsx rows, a page at a time. Memory is the automation's own
// note.
// The aside has the next fires, the tally of the kept runs and the
// setup. The words are Automations.model.ts and Schedule.model.ts.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import type { RunFilter } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import { navigate, path } from "../../app/router.ts";
import {
  automationError,
  automationProject,
  automations,
  automationsError,
  loadPreview,
  preview,
  previewKey,
  runDeadlineMs,
} from "../../data/automations.ts";
import { me } from "../../data/me.ts";
import { keyOf, noteErrors, notes } from "../../data/memory.ts";
import { project, projectError } from "../../data/projects.ts";
import { closeRunsOf, loadMoreRuns, runs } from "../../data/runs.ts";
import { projectAgents } from "../../data/sessions.ts";
import { longDate, sentence, until } from "../../lib/format.ts";
import { agentHref, automationHref, userHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { useCut } from "../../lib/resize.ts";
import { browserZone } from "../../lib/zone.ts";
import { tickMs } from "../../stream/Row.model.ts";
import { ShowMore } from "../../stream/Stream.tsx";
import { Fold } from "../../ui/Fold.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsCard, RowsFilters, RowsNote } from "../../ui/Rows.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { Note } from "../memory/Note.tsx";
import { AccessLines } from "./AutomationAccess.tsx";
import { AutomationActions } from "./AutomationActions.tsx";
import {
  automationPageOf,
  canChange,
  deadlineText,
  eventNote,
  nextLine,
  scheduleTitle,
  suspendedText,
} from "./Automations.model.ts";
import { RunRow } from "./RunRow.tsx";
import { fireLabel } from "./Schedule.model.ts";
import "./automations.css";

const FILTERS: { value: RunFilter | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "failed", label: "Failed" },
  { value: "manual", label: "Manual" },
];

// the instructions cut to a few lines, Show all in the fade once they
// run past them; measured again when the width moves the cut
function Instructions({
  text,
  foot,
}: {
  text: string;
  // the state line under the box
  foot: ComponentChildren;
}) {
  const { el, open, long } = useCut<HTMLParagraphElement>([text]);
  return (
    <>
      <div class="automations-brief-text">
        <Fold
          cut={long.value && !open.value}
          onOpen={() => {
            open.value = true;
          }}
          label="Show all"
        >
          <p
            ref={el}
            class={`automations-brief-body${open.value ? "" : " clamp"}`}
          >
            {text}
          </p>
        </Fold>
      </div>
      <div class="automations-brief-foot">{foot}</div>
    </>
  );
}

// the fires still ahead by the page's clock, so a page left open drops
// the ones gone by, and a fire waiting for a slot is not listed as next
function NextRuns({
  automation,
  now,
}: {
  automation: AutomationSummary;
  now: number;
}) {
  const key = previewKey(
    automation.projectId,
    automation.schedule,
    automation.tz,
  );
  const held = preview.value?.key === key ? preview.value : null;
  if (automation.agentRetired) {
    return <div class="split-line">Paused</div>;
  }
  if (automation.suspendedAt !== null) {
    return <div class="split-line">Suspended</div>;
  }
  return (
    <>
      {(held?.fires ?? [])
        .filter((fire) => fire > now)
        .map((fire) => (
          <div key={fire} class="split-line automations-fire">
            <span>{fireLabel(fire, now, automation.tz)}</span>
            <span class="automations-faint">{until(fire, now)}</span>
          </div>
        ))}
      {held?.problem && (
        <div class="split-line error">{sentence(held.problem)}</div>
      )}
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
  const { row, projectId, shown, error } = automationPageOf({
    id,
    rows: automations.value,
    found: automationProject.value,
    project: project.value,
    agentsIn: projectAgents.value !== null,
    failure:
      automationError.value ?? automationsError.value ?? projectError.value,
  });
  // the Memory tab is there only while the automation keeps its own note
  const memoryPath = path.value.endsWith("/memory");
  const tab = memoryPath && row?.ownMemory ? "memory" : "runs";
  useEffect(() => {
    if (memoryPath && row !== null && !row.ownMemory) {
      navigate(automationHref(id), true);
    }
  }, [memoryPath, row?.ownMemory, id]);
  const agents = projectAgents.value;
  const limit = runDeadlineMs.value;
  const held = runs.value?.id === id ? runs.value : null;
  const failure = useSignal<string | null>(null);
  const now = useNow(tickMs(held?.rows ?? null));
  // the runs are this page's; once it goes, no frame moves them
  useEffect(() => () => closeRunsOf(id), [id]);
  const noteKey = keyOf(projectId ?? "", id);
  const memoryNote = notes.value.get(noteKey) ?? null;
  // the next fires move with the schedule, and past each fire
  useEffect(() => {
    if (row === null || row.suspendedAt !== null) return;
    void loadPreview(row.projectId, row.schedule, row.tz);
  }, [row?.projectId, row?.schedule, row?.tz, row?.nextAt, row?.suspendedAt]);

  const ready = row !== null && shown !== null && agents !== null;
  const agent = agents?.find((a) => a.id === row?.agentId) ?? null;
  const deadlineMs = row?.deadlineMs ?? limit ?? 0;
  const filter = held?.filter ?? null;
  const tally = held?.tally ?? null;
  const total =
    tally === null
      ? 0
      : tally.done + tally.failed + tally.stopped + tally.running;
  const note = row === null ? null : eventNote(row, now);
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
                <NextRuns automation={row} now={now} />
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
                <AsideLine label="Deadline">
                  {deadlineText(deadlineMs)}
                </AsideLine>
                <AccessLines row={row} />
                <AsideLine label="Owner" href={userHref(row.ownerName)}>
                  @{row.ownerName}
                </AsideLine>
                <AsideLine label="Created">{longDate(row.createdAt)}</AsideLine>
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
              {row.agentRetired ? (
                <>
                  <span class="automations-agent-gone">@{row.agentName}</span>{" "}
                  <span class="tag">deleted</span>
                </>
              ) : (
                <a
                  class="automations-agent"
                  href={agentHref(agent?.name ?? row.agentName)}
                >
                  @{agent?.name ?? row.agentName}
                </a>
              )}{" "}
              is asked:
            </p>
            <Instructions
              text={row.instructions}
              foot={
                row.agentRetired || row.suspendedAt !== null ? (
                  <p class="automations-brief-next">
                    <Icon name="pause" size={14} />
                    {suspendedText(row, now)}
                  </p>
                ) : row.nextAt !== null ? (
                  <p class="automations-brief-next">
                    <Icon name="arrow-right" size={14} />
                    {nextLine(row, now)}
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
                href: automationHref(id),
                ...(tally === null ? {} : { count: total }),
              },
              ...(row.ownMemory
                ? [
                    {
                      label: "Memory",
                      href: `${automationHref(id)}/memory`,
                      ...(memoryNote === null
                        ? {}
                        : { count: memoryNote.entries.length }),
                    },
                  ]
                : []),
            ]}
            active={
              tab === "runs"
                ? automationHref(id)
                : `${automationHref(id)}/memory`
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
                    href: `${automationHref(id)}${
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
                <>
                  {held.rows.map((r) => (
                    <RunRow
                      key={r.session.id}
                      row={r}
                      deadlineMs={deadlineMs}
                      now={now}
                    />
                  ))}
                  <ShowMore
                    more={{
                      next: held.next !== null,
                      loading: held.more.loading,
                      error: held.more.error,
                    }}
                    onMore={() => void loadMoreRuns()}
                  />
                </>
              )}
            </RowsCard>
          )}
        </Split>
      )}
    </Page>
  );
}
