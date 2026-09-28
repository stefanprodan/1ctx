// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";
import type {
  OverviewDay,
  OverviewTotals,
  TurnLengths,
} from "../../../shared/api/admin.ts";
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

type DayCursor = Signal<number | null>;
type Active = { active: number; users: number };

type TileSpec = {
  label: string;
  plot: string;
  kind: "line" | "bars";
  values: (days: OverviewDay[]) => number[];
  words: (
    totals: OverviewTotals,
    at: OverviewDay | null,
    active: Active | undefined,
  ) => { figure: string; unit?: string; sub: string };
};

const tokensSpec: TileSpec = {
  label: "Tokens",
  plot: "Tokens per day",
  kind: "line",
  values: (days) => days.map(tokensOf),
  words: tokensTile,
};

const STATS_TILES: TileSpec[] = [
  {
    label: "Active users",
    plot: "Active users per day",
    kind: "bars",
    values: (days) => days.map((d) => d.activeUsers),
    words: (_t, at, active) => activeTile(active!.active, active!.users, at),
  },
  {
    label: "Failure rate",
    plot: "Failure rate per day",
    kind: "line",
    values: failureSeries,
    words: failureTile,
  },
  {
    label: "Decisions",
    plot: "Decisions per day",
    kind: "bars",
    values: (days) => days.map((d) => d.decisions),
    words: decisionsTile,
  },
  tokensSpec,
];

const USAGE_TILES: TileSpec[] = [
  tokensSpec,
  {
    label: "Cost",
    plot: "Cost per day",
    kind: "line",
    // flat at zero where no provider priced either
    values: (days) => days.map((d) => costOf(d) ?? 0),
    words: costTile,
  },
  {
    label: "Chats",
    plot: "Chat turns per day",
    kind: "bars",
    values: (days) => days.map((d) => d.turns),
    words: turnsTile,
  },
  {
    label: "Automations",
    plot: "Automation runs per day",
    kind: "bars",
    values: (days) => days.map((d) => d.runs),
    words: (totals, at) => runsTile(totals, at),
  },
];

function useDays(days: OverviewDay[], day: DayCursor) {
  const starts = useMemo(() => days.map((d) => d.start), [days]);
  return {
    starts,
    at: day.value === null ? null : (days[day.value] ?? null),
    onCursor: (index: number | null) => {
      day.value = index;
    },
  };
}

// without the active users, Usage's tiles
export function DaysTiles({
  days,
  totals,
  day,
  sync,
  active,
}: {
  days: OverviewDay[];
  totals: OverviewTotals;
  day: DayCursor;
  sync: string;
  active?: Active;
}) {
  const { starts, at, onCursor } = useDays(days, day);
  const specs = active ? STATS_TILES : USAGE_TILES;
  const values = useMemo(() => specs.map((s) => s.values(days)), [days, specs]);
  return (
    <Tiles>
      {specs.map((s, i) => {
        const words = s.words(totals, at, active);
        return (
          <Tile
            key={s.label}
            label={s.label}
            figure={words.figure}
            unit={words.unit}
            sub={words.sub}
          >
            <TilePlot label={s.plot}>
              <Spark
                kind={s.kind}
                times={starts}
                values={values[i]!}
                sync={sync}
                onCursor={onCursor}
              />
            </TilePlot>
          </Tile>
        );
      })}
    </Tiles>
  );
}

function DayPanel({
  label,
  hint,
  none,
  children,
}: {
  label: string;
  hint: string | undefined;
  // drawn in place of the plot
  none?: string;
  children: ComponentChildren;
}) {
  return (
    <ChartPanel label={label} hint={hint} hintBelow>
      {none === undefined ? children : <p class="chart-none">{none}</p>}
    </ChartPanel>
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
  none: string;
}) {
  const { starts, at, onCursor } = useDays(days, day);
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
  return (
    <DayPanel
      label="Tokens per day"
      hint={any ? (at ? dayTokensHint(at) : tokensHint(totals)) : undefined}
      none={any ? undefined : none}
    >
      <DayBars
        label="Tokens per day"
        days={starts}
        series={series}
        sync={sync}
        onCursor={onCursor}
      />
    </DayPanel>
  );
}

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
  const { starts, at, onCursor } = useDays(days, day);
  const series = useMemo(() => activitySeries(days), [days]);
  return (
    <DayPanel
      label="Activity"
      hint={activityHint(totals, at) || undefined}
      none={totals.turns + totals.runs > 0 ? undefined : "No turns or runs"}
    >
      <DayBars
        label="Turns and runs per day"
        days={starts}
        series={series}
        stack="activity"
        sync={sync}
        onCursor={onCursor}
      />
    </DayPanel>
  );
}

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
  const { starts, at, onCursor } = useDays(days, day);
  const series = useMemo(() => lengthSeries(days), [days]);
  return (
    <DayPanel
      label="LLM response time"
      hint={lengthHint(lengths, at) || undefined}
      none={lengths.medianMs !== null ? undefined : "No chat turns ended"}
    >
      <DayLines
        label="LLM response time per day"
        days={starts}
        series={series}
        words={lengthAxis}
        steps={LENGTH_STEPS}
        sync={sync}
        onCursor={onCursor}
      />
    </DayPanel>
  );
}

const DAY_HEIGHTS = [
  38, 60, 52, 41, 20, 14, 62, 60, 60, 50, 48, 18, 34, 54, 64, 76, 56, 42, 12,
  18, 64, 62, 58, 96, 50, 20, 10, 46, 64, 70,
];

export function TokensGhost({ at }: { at: number }) {
  return (
    <ChartPanel label="Tokens per day" hintBelow>
      <div class="chart-days">
        <div class="chart-key">
          <Bone kind="title" at={at} width={30} />
        </div>
        <div class="chart-plot chart-ghost-days">
          {DAY_HEIGHTS.map((h, i) => (
            <Bone key={i} kind="column" at={at + 1 + i} height={h} />
          ))}
        </div>
      </div>
    </ChartPanel>
  );
}
