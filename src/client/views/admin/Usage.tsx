// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A calendar month of use: the month's tiles and its tokens a day, then
// the tokens by project, agent or model, how long each model's turns
// take, and the deciders by their decisions. The month is in the
// address (?month=2026-09), this month without one, and the head's
// arrows step a month at a time between the first turn's and this one. Loaded when a month
// is reached; a pick keeps the last month on screen, faded, until the
// new one lands.

import { useSignal } from "@preact/signals";
import type { UsageResponse } from "../../../shared/api/admin.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  thisMonth,
  usage,
  usageError,
  usageLoading,
  usageMonth,
} from "../../data/overview.ts";
import { Icon } from "../../lib/icons.tsx";
import { BarsGhost } from "../../ui/Bones.tsx";
import { Bars, ChartPanel } from "../../ui/Chart.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsFilters } from "../../ui/RowsControls.tsx";
import { DaysTiles, TokensGhost, TokensPanel } from "./Days.tsx";
import { OverviewGhost } from "./OverviewNow.tsx";
import {
  deciderBars,
  lengthBars,
  modelBars,
  monthLabel,
  monthSteps,
  usageBars,
} from "./Usage.model.ts";
import "./overview.css";
import "./usage.css";

const SYNC = "usage";
const NO_TURNS = "No turns this month";

const BY = [
  { key: "projects", label: "Projects" },
  { key: "agents", label: "Agents" },
  { key: "models", label: "Models" },
] as const;
type By = (typeof BY)[number]["key"];

type Bar = {
  key: string;
  name: string;
  value: number;
  label: string;
  hint: string;
  mono?: boolean;
  gone?: boolean;
};

// a panel of bars whose hint follows the pointer
function BarsPanel({
  label,
  rest,
  bars,
  none,
  action,
}: {
  label: string;
  // the hint with no bar under the pointer
  rest?: string;
  bars: Bar[];
  none: string;
  action?: preact.ComponentChildren;
}) {
  const over = useSignal<string | null>(null);
  return (
    <ChartPanel
      label={label}
      hint={bars.find((b) => b.key === over.value)?.hint ?? rest}
      action={action}
    >
      {bars.length === 0 ? (
        <p class="chart-none">{none}</p>
      ) : (
        <Bars
          wide
          bars={bars}
          onHover={(key) => {
            over.value = key;
          }}
        />
      )}
    </ChartPanel>
  );
}

function ByPanel({ answer }: { answer: UsageResponse }) {
  const kind = useSignal<By>("projects");
  const bars =
    kind.value === "models"
      ? modelBars(answer.by.models)
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
      // a new kind starts with no bar under the pointer
      key={kind.value}
      label="Usage"
      bars={bars}
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
        <div class="overview-wide">
          <TokensPanel
            days={answer.days}
            totals={answer.totals}
            day={day}
            sync={SYNC}
            none={NO_TURNS}
          />
        </div>
        <ByPanel answer={answer} />
        <BarsPanel
          label="Turn length"
          rest="median"
          bars={lengthBars(answer.lengths).map((b) => ({ ...b, mono: true }))}
          none={NO_TURNS}
        />
        {answer.deciders.length > 0 && (
          <BarsPanel
            label="Decisions"
            bars={deciderBars(answer.deciders)}
            none=""
          />
        )}
      </div>
    </>
  );
}

const BAR_WIDTHS = [100, 62, 40, 26, 14];
const LENGTH_WIDTHS = [100, 48, 30, 12];

function BoardGhost() {
  return (
    <>
      <OverviewGhost at={0} />
      <div class="chart-grid chart-board-ghost" aria-hidden="true">
        <div class="overview-wide">
          <TokensGhost at={16} />
        </div>
        <ChartPanel label="Usage">
          <BarsGhost widths={BAR_WIDTHS} at={48} wide />
        </ChartPanel>
        <ChartPanel label="Turn length">
          <BarsGhost widths={LENGTH_WIDTHS} at={64} wide />
        </ChartPanel>
      </div>
    </>
  );
}

// an arrow is a link to its month, or faded where there is none
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
      href={`/monitor/usage?month=${to}`}
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
        class={`chart-board${answer && (busy || error) ? " usage-stale" : ""}`}
        aria-busy={busy}
      >
        {answer ? <Board answer={answer} /> : <BoardGhost />}
      </div>
    </Page>
  );
}
