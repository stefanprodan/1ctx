// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation's page. The summary reads as one sentence: when, in which
// zone, which agent is asked, then the instructions as the agent gets
// them, cut to a few lines, and under them the next run and the last
// check. An automation whose agent was deleted names
// it with a tag and says it is paused until an edit picks another.
// Suspend or Resume, Run now, Edit and Delete, which anyone in the
// project presses, sit over two tabs. Runs is a log of RunRow.tsx rows,
// a page at a time, filtered to the manual or the flagged runs. An open
// alert sits over the summary with Dismiss. Memory is the automation's
// own note.
// The aside has the next fires, the tally of the kept runs and the
// setup. The words are Automations.model.ts and Schedule.model.ts.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import {
  type AutomationSummary,
  ranOnce,
} from "../../../shared/contracts/automation.ts";
import { DEFERRED_BY_RESTART, type RunFilter } from "../../../shared/words.ts";
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
import { keyOf, noteErrors, notes } from "../../data/memory.ts";
import { project, projectError } from "../../data/projects.ts";
import { closeRunsOf, loadMoreRuns, runs } from "../../data/runs.ts";
import { projectAgents } from "../../data/sessions.ts";
import { ShowMore } from "../../feed/FeedCard.tsx";
import { tickMs } from "../../feed/Row.model.ts";
import { longDate, sentence, until } from "../../lib/format.ts";
import {
  agentHref,
  automationHref,
  runHref,
  userHref,
} from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { useCut } from "../../lib/resize.ts";
import { browserZone } from "../../lib/zone.ts";
import { Fold } from "../../ui/Fold.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsCard, RowsFilters, RowsNote } from "../../ui/Rows.tsx";
import {
  AsideItem,
  AsideLine,
  AsideNote,
  AsideSection,
  Split,
} from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { Note } from "../memory/Note.tsx";
import { ATTENTION_LABELS } from "./Attention.model.ts";
import { AccessLines } from "./AutomationAccess.tsx";
import { AutomationActions } from "./AutomationActions.tsx";
import {
  automationPageOf,
  checkLine,
  eventNote,
  nextLine,
  nextRunsOf,
  suspendedText,
} from "./Automations.model.ts";
import { OpenAttention } from "./OpenAttention.tsx";
import { deadlineText } from "./Run.model.ts";
import { RunRow } from "./RunRow.tsx";
import { fireLabel, scheduleTitle } from "./Schedule.model.ts";
import "./automations.css";

const FILTERS: { value: RunFilter | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "manual", label: "Manual" },
  { value: "attention", label: "Flagged" },
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
      <div class="automations-summary-text">
        <Fold
          cut={long.value && !open.value}
          onOpen={() => {
            open.value = true;
          }}
          label="Show all"
        >
          <p
            ref={el}
            class={`automations-summary-body${open.value ? "" : " clamp"}`}
          >
            {text}
          </p>
        </Fold>
      </div>
      <div class="automations-summary-foot">{foot}</div>
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
    return <AsideNote>Paused</AsideNote>;
  }
  if (automation.suspendedAt !== null) {
    return <AsideNote>Suspended</AsideNote>;
  }
  // an automation that runs once has one fire, named with its year
  const next = nextRunsOf(automation, held?.fires ?? [], now);
  return (
    <>
      {next.waiting !== null && <AsideNote>{next.waiting}</AsideNote>}
      {next.fires.map((fire) => (
        <AsideItem
          key={fire}
          name={fireLabel(fire, now, automation.tz, false, automation.once)}
          quiet
        >
          {until(fire, now)}
        </AsideItem>
      ))}
      {held?.problem && (
        <AsideNote tone="error">{sentence(held.problem)}</AsideNote>
      )}
      {automation.tz !== browserZone() && (
        <AsideNote tone="faint">In {automation.tz}</AsideNote>
      )}
    </>
  );
}

// Both tabs' routes name this one view, so a tab change keeps the page
// mounted: the summary, the aside and the runs stay while only the tab's
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
  const check = row === null ? null : checkLine(row, now);
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
                  <p class="split-empty">Loading</p>
                ) : (
                  <>
                    <AsideNote>
                      {total} {total === 1 ? "run" : "runs"} ·{" "}
                      {row.retentionDays}{" "}
                      {row.retentionDays === 1 ? "day" : "days"} retention
                    </AsideNote>
                    <AsideNote>
                      {[
                        tally.running > 0 ? `${tally.running} running` : null,
                        `${tally.done} done`,
                        `${tally.failed} failed`,
                        `${tally.stopped} stopped`,
                      ]
                        .filter((s) => s !== null)
                        .join(" · ")}
                    </AsideNote>
                  </>
                )}
              </AsideSection>
              <AsideSection label="Setup">
                <AsideLine label="Deadline">
                  {deadlineText(deadlineMs)}
                </AsideLine>
                <AsideLine label="Needs attention">
                  {ATTENTION_LABELS[row.attentionMode]}
                </AsideLine>
                {row.checkUrl !== null && (
                  <AsideLine label="Check URL">{row.checkUrl}</AsideLine>
                )}
                <AccessLines row={row} />
                {row.rerunOnRestart && (
                  <AsideNote>Restarts a run the server stopped</AsideNote>
                )}
                {row.postToChannel && (
                  <AsideNote>Posts its answer to the channel</AsideNote>
                )}
                <AsideLine label="Owner" href={userHref(row.ownerName)}>
                  @{row.ownerName}
                </AsideLine>
                <AsideLine label="Created">{longDate(row.createdAt)}</AsideLine>
              </AsideSection>
            </>
          }
        >
          {row.alert !== null && (
            <OpenAttention id={row.id} alert={row.alert} now={now} />
          )}
          <section class="card automations-summary">
            <p class="automations-summary-line">
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
                <>
                  {row.agentRetired || row.suspendedAt !== null ? (
                    <p class="automations-summary-next">
                      <Icon name="pause" size={14} />
                      {/* the run that spent it says how it went */}
                      {!row.agentRetired &&
                      ranOnce(row) &&
                      row.onceRunSessionId !== null ? (
                        <a href={runHref(row.onceRunSessionId)}>
                          {suspendedText(row, now)}
                        </a>
                      ) : (
                        suspendedText(row, now)
                      )}
                    </p>
                  ) : row.nextAt !== null ? (
                    <p class="automations-summary-next">
                      <Icon name="arrow-right" size={14} />
                      {nextLine(row, now)}
                    </p>
                  ) : null}
                  {check !== null && (
                    <p class="automations-summary-next">
                      <Icon
                        name={check.failed ? "alert" : "globe"}
                        size={14}
                        class={
                          check.failed ? "automations-check-failed" : undefined
                        }
                      />
                      {check.text}
                    </p>
                  )}
                </>
              }
            />
          </section>
          {note !== null && <p class="automations-note">{note}</p>}
          <AutomationActions
            automation={row}
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
                  {filter === "manual"
                    ? "No manual runs."
                    : filter === "attention"
                      ? "Nothing flagged."
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
                      deferred={
                        row?.lastRunSessionId === r.session.id &&
                        row.lastEventReason === DEFERRED_BY_RESTART
                      }
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
