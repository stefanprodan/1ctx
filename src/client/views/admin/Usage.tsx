// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { UsageResponse } from "../../../shared/api/admin.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  thisMonth,
  usage,
  usageError,
  usageLoading,
  usageMonth,
  watchUsage,
} from "../../data/overview.ts";
import { Icon } from "../../lib/icons.tsx";
import { BarsGhost } from "../../ui/Bones.tsx";
import { BarsPanel, ChartPanel } from "../../ui/Chart.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsFilters } from "../../ui/RowsControls.tsx";
import { DaysTiles, TokensGhost, TokensPanel } from "./Days.tsx";
import { OverviewGhost } from "./OverviewNow.tsx";
import {
  agentBars,
  modelBars,
  monthLabel,
  monthSteps,
  usageBars,
} from "./Usage.model.ts";
import "./usage.css";

const SYNC = "usage";
const NO_TURNS = "No turns this month";

const BY = [
  { key: "projects", label: "Projects" },
  { key: "agents", label: "Agents" },
  { key: "models", label: "Models" },
] as const;
type By = (typeof BY)[number]["key"];

function ByPanel({ answer }: { answer: UsageResponse }) {
  const kind = useSignal<By>("projects");
  const bars =
    kind.value === "models"
      ? modelBars(answer.by.models)
      : kind.value === "agents"
        ? agentBars(answer.by.agents, answer.deciders)
        : usageBars(kind.value, answer.by[kind.value]);
  const filters = BY.map((b) => ({
    label: b.label,
    on: kind.value === b.key,
    onPick: () => {
      kind.value = b.key;
    },
  }));
  return (
    <BarsPanel
      // a new kind forgets the bar under the pointer
      key={kind.value}
      label="Usage"
      bars={bars.map(({ cost, costly, ...b }) => ({
        ...b,
        label:
          cost === undefined ? (
            b.label
          ) : (
            <>
              {b.label}
              <span class={`chart-share${costly ? " chart-costly" : ""}`}>
                {cost}
              </span>
            </>
          ),
      }))}
      wide
      none={NO_TURNS}
      action={<RowsFilters label="Usage by" filters={filters} />}
    />
  );
}

function Board({ answer }: { answer: UsageResponse }) {
  const day = useSignal<number | null>(null);
  return (
    <>
      <DaysTiles
        days={answer.days}
        totals={answer.totals}
        day={day}
        sync={SYNC}
      />
      <div class="chart-grid">
        <div class="chart-wide">
          <TokensPanel
            days={answer.days}
            totals={answer.totals}
            day={day}
            sync={SYNC}
            none={NO_TURNS}
          />
        </div>
        <div class="chart-wide">
          <ByPanel answer={answer} />
        </div>
      </div>
    </>
  );
}

const BAR_WIDTHS = [100, 62, 40, 26, 14];

function BoardGhost() {
  return (
    <>
      <OverviewGhost at={0} />
      <div class="chart-grid chart-board-ghost" aria-hidden="true">
        <div class="chart-wide">
          <TokensGhost at={16} />
        </div>
        <div class="chart-wide">
          <ChartPanel label="Usage">
            <BarsGhost widths={BAR_WIDTHS} at={48} wide />
          </ChartPanel>
        </div>
      </div>
    </>
  );
}

function Step({
  to,
  label,
  icon,
}: {
  to: string | null;
  label: string;
  icon: "chevron-left" | "chevron-right";
}) {
  return to === null ? (
    <span class="btn-icon usage-step usage-step-off" aria-hidden="true">
      <Icon name={icon} size={16} />
    </span>
  ) : (
    <a
      class="btn-icon usage-step"
      href={`/admin/monitor/usage?month=${to}`}
      aria-label={`${label}, ${monthLabel(to)}`}
      title={monthLabel(to)}
    >
      <Icon name={icon} size={16} />
    </a>
  );
}

function MonthSteps({ month, first }: { month: string; first: string | null }) {
  const steps = monthSteps(month, first, thisMonth());
  return (
    <nav class="usage-months" aria-label="Month">
      <Step to={steps.back} label="Previous month" icon="chevron-left" />
      <span class="usage-month" aria-current="page">
        <span class="usage-month-long">{monthLabel(month)}</span>
        <span class="usage-month-short">{monthLabel(month, true)}</span>
      </span>
      <Step to={steps.forward} label="Next month" icon="chevron-right" />
    </nav>
  );
}

export function Usage() {
  useEffect(() => watchUsage(), []);
  const answer = usage.value;
  const error = usageError.value;
  const busy = usageLoading.value;
  const month = usageMonth.value ?? thisMonth();
  const first = answer?.since == null ? null : thisMonth(answer.since);
  return (
    <Page
      steps={[zoneStep("Monitor")]}
      title="Usage"
      actions={<MonthSteps month={month} first={first} />}
      error={answer === null && !busy ? error : null}
    >
      <div
        class={`chart-board${answer && (busy || error) ? " chart-stale" : ""}`}
        aria-busy={busy}
      >
        {answer ? <Board answer={answer} /> : <BoardGhost />}
      </div>
    </Page>
  );
}
