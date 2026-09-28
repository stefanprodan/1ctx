// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A span of days as the Monitor pages draw it: four tiles on one
// cursor and the charts under them, sharing the day under the pointer.
// The Monitor's Stats draw active users, the failure rate, decisions
// and tokens over the activity and turn length charts; Usage a month's
// turns, runs, tokens and cost, money being Usage's alone, and its
// tokens chart.

import { useMemo } from "preact/hooks";
import type {
  OverviewDay,
  OverviewTotals,
  TurnLengths,
} from "../../../shared/api/admin.ts";
import { count } from "../../lib/format.ts";
import { Bone } from "../../ui/Bones.tsx";
import { ChartPanel } from "../../ui/Chart.tsx";
import { DayBars, DayLines, type DaySeries, Spark } from "../../ui/Plot.tsx";
import { Tile, TilePlot, Tiles } from "../../ui/Tiles.tsx";
import {
  costOf,
  costTile,
  dayTokensHint,
  decisionsTile,
  runsTile,
  tokensHint,
  tokensOf,
  tokensTile,
  turnsTile,
} from "./Overview.model.ts";
import {
  activeTile,
  activityHint,
  activitySeries,
  failureSeries,
  failureTile,
  LENGTH_STEPS,
  lengthAxis,
  lengthHint,
  lengthSeries,
} from "./Stats.model.ts";
import "./overview.css";

export type DayCursor = { value: number | null };

export function DaysTiles({
  days,
  totals,
  day,
  sync,
  people,
}: {
  days: OverviewDay[];
  totals: OverviewTotals;
  // the day under the cursor, shared with the charts
  day: DayCursor;
  sync: string;
  // the Monitor's tiles: who was active and what failed, then
  // decisions and tokens; without, Usage's: tokens and cost, then
  // turns and runs with the decisions in their line
  people?: { active: number; users: number };
}) {
  const spend = people === undefined;
  const series = useMemo(
    () => ({
      starts: days.map((d) => d.start),
      turns: days.map((d) => d.turns),
      runs: days.map((d) => d.runs),
      decisions: days.map((d) => d.decisions),
      active: days.map((d) => d.activeUsers),
      failed: failureSeries(days),
      tokens: days.map((d) => tokensOf(d)),
      // the rounds and the decisions, flat at zero where no provider
      // priced either
      cost: days.map((d) => costOf(d) ?? 0),
    }),
    [days],
  );
  const onCursor = (index: number | null) => {
    day.value = index;
  };
  const at = day.value === null ? null : (days[day.value] ?? null);
  const turns = turnsTile(totals, at);
  const runs = runsTile(totals, at, spend);
  const decisions = decisionsTile(totals, at);
  const tokens = tokensTile(totals, at);
  const cost = costTile(totals, at);
  const spark = (kind: "line" | "bars", values: number[]) => (
    <Spark
      kind={kind}
      times={series.starts}
      values={values}
      sync={sync}
      onCursor={onCursor}
    />
  );
  if (people) {
    const active = activeTile(people.active, people.users, at);
    const failure = failureTile(totals, at);
    return (
      <Tiles>
        <Tile
          label="Active users"
          figure={active.figure}
          unit={active.unit}
          sub={active.sub}
        >
          <TilePlot label="Active users per day">
            {spark("bars", series.active)}
          </TilePlot>
        </Tile>
        <Tile label="Failure rate" figure={failure.figure} sub={failure.sub}>
          <TilePlot label="Failure rate per day">
            {spark("line", series.failed)}
          </TilePlot>
        </Tile>
        <Tile
          label="Decisions"
          figure={decisions.figure}
          unit={decisions.unit}
          sub={decisions.sub}
        >
          <TilePlot label="Decisions per day">
            {spark("bars", series.decisions)}
          </TilePlot>
        </Tile>
        <Tile label="Tokens" figure={tokens.figure} sub={tokens.sub}>
          <TilePlot label="Tokens per day">
            {spark("line", series.tokens)}
          </TilePlot>
        </Tile>
      </Tiles>
    );
  }
  return (
    <Tiles>
      <Tile label="Tokens" figure={tokens.figure} sub={tokens.sub}>
        <TilePlot label="Tokens per day">
          {spark("line", series.tokens)}
        </TilePlot>
      </Tile>
      <Tile label="Cost" figure={cost.figure} sub={cost.sub}>
        <TilePlot label="Cost per day">{spark("line", series.cost)}</TilePlot>
      </Tile>
      <Tile
        label="Chats"
        figure={turns.figure}
        unit={turns.unit}
        sub={turns.sub}
      >
        <TilePlot label="Chat turns per day">
          {spark("bars", series.turns)}
        </TilePlot>
      </Tile>
      <Tile
        label="Automations"
        figure={runs.figure}
        unit={runs.unit}
        sub={runs.sub}
      >
        <TilePlot label="Automation runs per day">
          {spark("bars", series.runs)}
        </TilePlot>
      </Tile>
    </Tiles>
  );
}

export function TokensPanel({
  days,
  totals,
  day,
  sync,
  none,
}: {
  days: OverviewDay[];
  totals: OverviewTotals;
  day: DayCursor;
  sync: string;
  // what the panel says with no tokens in the span
  none: string;
}) {
  const starts = useMemo(() => days.map((d) => d.start), [days]);
  const series = useMemo<DaySeries[]>(
    () => [
      {
        label: "Input",
        values: days.map((d) => Math.max(0, d.promptTokens - d.cachedTokens)),
      },
      { label: "Cached input", values: days.map((d) => d.cachedTokens) },
      { label: "Output", values: days.map((d) => d.completionTokens) },
    ],
    [days],
  );
  const any = tokensOf(totals) > 0;
  const at = day.value === null ? null : days[day.value];
  return (
    <ChartPanel
      label="Tokens per day"
      hint={any ? (at ? dayTokensHint(at) : tokensHint(totals)) : undefined}
      hintBelow
    >
      {any ? (
        <DayBars
          label="Tokens per day"
          days={starts}
          series={series}
          words={(v) => (v === 0 ? "0" : count(v))}
          sync={sync}
          onCursor={(i) => {
            day.value = i;
          }}
        />
      ) : (
        <p class="chart-none">{none}</p>
      )}
    </ChartPanel>
  );
}

// turns and runs a day, the failed ones on top, on the tiles' cursor
export function ActivityPanel({
  days,
  totals,
  day,
  sync,
}: {
  days: OverviewDay[];
  totals: OverviewTotals;
  day: DayCursor;
  sync: string;
}) {
  const starts = useMemo(() => days.map((d) => d.start), [days]);
  const series = useMemo(() => activitySeries(days), [days]);
  const at = day.value === null ? null : (days[day.value] ?? null);
  return (
    <ChartPanel
      label="Activity"
      hint={activityHint(totals, at) || undefined}
      hintBelow
    >
      {totals.turns + totals.runs > 0 ? (
        <DayBars
          label="Turns and runs per day"
          days={starts}
          series={series}
          stack="activity"
          words={(v) => (v === 0 ? "0" : count(v))}
          sync={sync}
          onCursor={(i) => {
            day.value = i;
          }}
        />
      ) : (
        <p class="chart-none">No turns or runs</p>
      )}
    </ChartPanel>
  );
}

// how long chat turns took a day: the median over the 95th percentile
export function LengthPanel({
  days,
  lengths,
  day,
  sync,
}: {
  days: OverviewDay[];
  lengths: TurnLengths;
  day: DayCursor;
  sync: string;
}) {
  const starts = useMemo(() => days.map((d) => d.start), [days]);
  const series = useMemo(() => lengthSeries(days), [days]);
  const at = day.value === null ? null : (days[day.value] ?? null);
  return (
    <ChartPanel
      label="LLM response time"
      hint={lengthHint(lengths, at) || undefined}
      hintBelow
    >
      {lengths.medianMs !== null ? (
        <DayLines
          label="LLM response time per day"
          days={starts}
          series={series}
          words={lengthAxis}
          steps={LENGTH_STEPS}
          sync={sync}
          onCursor={(i) => {
            day.value = i;
          }}
        />
      ) : (
        <p class="chart-none">No chat turns ended</p>
      )}
    </ChartPanel>
  );
}

const DAY_HEIGHTS = [
  38, 60, 52, 41, 20, 14, 62, 60, 60, 50, 48, 18, 34, 54, 64, 76, 56, 42, 12,
  18, 64, 62, 58, 96, 50, 20, 10, 46, 64, 70,
];

// the tokens chart while its first answer loads
export function TokensGhost({ at }: { at: number }) {
  return (
    <ChartPanel label="Tokens per day" hintBelow>
      <div class="chart-days">
        <div class="chart-key">
          <Bone kind="title" at={at} width={30} />
        </div>
        <div class="chart-plot overview-ghost-days">
          {DAY_HEIGHTS.map((h, i) => (
            <Bone key={i} kind="column" at={at + 1 + i} height={h} />
          ))}
        </div>
      </div>
    </ChartPanel>
  );
}
