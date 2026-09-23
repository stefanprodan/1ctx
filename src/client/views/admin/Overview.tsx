// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The instance at a glance, as a board over a range of days: four
// tiles (sends, tokens, cost, what runs now), the tokens of each day
// stacked by kind, the usage by users, agents, models, projects or
// tasks beside how long each model's sends take, and a faint line of
// the instance. The range is the address (?days=), loaded on arrival,
// on a range change and on Refresh; the first load draws the board in
// bones, a later one fades the last answer until the next lands.

import { useSignal } from "@preact/signals";
import { useMemo } from "preact/hooks";
import {
  OVERVIEW_RANGES,
  type OverviewResponse,
  USAGE_BY,
  type UsageBy,
} from "../../../shared/api/admin.ts";
import { query } from "../../app/router.ts";
import {
  loadOverview,
  overview,
  overviewError,
  overviewLoading,
  rangeOf,
} from "../../data/overview.ts";
import { count } from "../../lib/format.ts";
import { BarsGhost, Bone } from "../../ui/Bones.tsx";
import {
  Bars,
  ChartPanel,
  DayBars,
  type DaySeries,
  Spark,
} from "../../ui/Chart.tsx";
import { Loaded } from "../../ui/Loaded.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsFilters } from "../../ui/Rows.tsx";
import {
  Tile,
  TileGhost,
  TileMeter,
  TilePlot,
  Tiles,
} from "../../ui/Tiles.tsx";
import {
  cachedLine,
  costTile,
  databaseWords,
  dayLine,
  instanceLine,
  modelBars,
  rangeLine,
  runningTile,
  sendsLine,
  tokensOf,
  usageBars,
} from "./Overview.model.ts";
import "./overview.css";

const SYNC = "overview";

const BY_LABELS: Record<UsageBy, string> = {
  users: "Users",
  agents: "Agents",
  models: "Models",
  projects: "Projects",
  tasks: "Tasks",
};

function OverviewTiles({ answer }: { answer: OverviewResponse }) {
  const { days, totals, before, now } = answer;
  const day = useSignal<number | null>(null);
  const series = useMemo(
    () => ({
      starts: days.map((d) => d.start),
      sends: days.map((d) => d.sends),
      tokens: days.map((d) => tokensOf(d)),
    }),
    [days],
  );
  const onCursor = (index: number | null) => {
    day.value = index;
  };
  const at = day.value === null ? null : days[day.value];
  const cost = costTile(totals);
  const running = runningTile(now);
  return (
    <Tiles>
      <Tile
        label="Sends"
        figure={count(totals.sends)}
        sub={at ? dayLine(at) : sendsLine(totals, before, days.length)}
      >
        <TilePlot label="Sends per day">
          <Spark
            kind="bars"
            days={series.starts}
            values={series.sends}
            sync={SYNC}
            onCursor={onCursor}
          />
        </TilePlot>
      </Tile>
      <Tile
        label="Tokens"
        figure={count(tokensOf(totals))}
        sub={at ? dayLine(at) : cachedLine(totals)}
      >
        <TilePlot label="Tokens per day">
          <Spark
            kind="line"
            days={series.starts}
            values={series.tokens}
            sync={SYNC}
            onCursor={onCursor}
          />
        </TilePlot>
      </Tile>
      <Tile label="Cost" figure={cost.figure} sub={cost.sub} />
      <Tile
        label="Running now"
        figure={running.figure}
        unit={running.unit}
        sub={running.sub}
      >
        <TileMeter share={running.share} />
      </Tile>
    </Tiles>
  );
}

function TokensPanel({ answer }: { answer: OverviewResponse }) {
  const { days, totals } = answer;
  const day = useSignal<number | null>(null);
  const starts = useMemo(() => days.map((d) => d.start), [days]);
  const series = useMemo<DaySeries[]>(
    () => [
      {
        label: "Prompt",
        values: days.map((d) => Math.max(0, d.promptTokens - d.cachedTokens)),
      },
      { label: "Cached", values: days.map((d) => d.cachedTokens) },
      { label: "Completion", values: days.map((d) => d.completionTokens) },
    ],
    [days],
  );
  const at = day.value === null ? null : days[day.value];
  return (
    <ChartPanel
      label="Tokens per day"
      hint={at ? dayLine(at) : rangeLine(totals)}
    >
      <DayBars
        days={starts}
        series={series}
        words={(v) => (v === 0 ? "0" : count(v))}
        onCursor={(i) => {
          day.value = i;
        }}
      />
    </ChartPanel>
  );
}

function UsagePanel({ answer }: { answer: OverviewResponse }) {
  const kind = useSignal<UsageBy>("users");
  const over = useSignal<string | null>(null);
  const bars = usageBars(
    kind.value,
    answer.by[kind.value],
    tokensOf(answer.totals),
  );
  const filters = USAGE_BY.map((k) => ({
    label: BY_LABELS[k],
    on: kind.value === k,
    onPick: () => {
      kind.value = k;
      over.value = null;
    },
  }));
  return (
    <ChartPanel
      label="Usage by"
      hint={bars.find((b) => b.key === over.value)?.hint ?? "tokens"}
      action={<RowsFilters label="Usage by" filters={filters} />}
    >
      {bars.length === 0 ? (
        <p class="overview-none">Nothing in this range</p>
      ) : (
        <Bars
          bars={bars.map((b) => ({
            key: b.key,
            name: b.name,
            value: b.value,
            hint: b.hint,
            mono: b.mono,
            label: (
              <>
                {b.tokens}
                <span class="chart-share">{b.share}</span>
              </>
            ),
          }))}
          onHover={(key) => {
            over.value = key;
          }}
        />
      )}
    </ChartPanel>
  );
}

function ModelsPanel({ answer }: { answer: OverviewResponse }) {
  const over = useSignal<string | null>(null);
  const bars = modelBars(answer.models);
  return (
    <ChartPanel
      label="Send length"
      hint={bars.find((b) => b.key === over.value)?.hint ?? "median"}
    >
      {bars.length === 0 ? (
        <p class="overview-none">No sends in this range</p>
      ) : (
        <Bars
          wide
          bars={bars.map((b) => ({ ...b, mono: true }))}
          onHover={(key) => {
            over.value = key;
          }}
        />
      )}
    </ChartPanel>
  );
}

function Board({ answer }: { answer: OverviewResponse }) {
  return (
    <>
      <OverviewTiles answer={answer} />
      <div class="overview-grid">
        <div class="overview-wide">
          <TokensPanel answer={answer} />
        </div>
        <UsagePanel answer={answer} />
        <ModelsPanel answer={answer} />
      </div>
      <p class="overview-facts">
        {instanceLine(answer.instance, answer.readAt)} ·{" "}
        <a class="overview-facts-link" href="/admin/storage">
          {databaseWords(answer.instance.databaseBytes)}
        </a>
      </p>
    </>
  );
}

const BAR_WIDTHS = [100, 62, 40, 26, 14, 8];
const MODEL_WIDTHS = [100, 48, 30, 12];
const DAY_HEIGHTS = [
  38, 60, 52, 41, 20, 14, 62, 60, 60, 50, 48, 18, 34, 54, 64, 76, 56, 42, 12,
  18, 64, 62, 58, 96, 50, 20, 10, 46, 64, 70,
];

// the board while its first answer loads, in the loaded board's shape
function BoardGhost() {
  return (
    <div class="overview-ghost" aria-hidden="true">
      <Tiles>
        {[0, 4, 8, 12].map((at) => (
          <TileGhost key={at} at={at} />
        ))}
      </Tiles>
      <div class="overview-grid">
        <div class="overview-wide">
          <ChartPanel label="Tokens per day">
            <div class="chart-days">
              <div class="chart-key">
                <Bone kind="title" at={16} width={30} />
              </div>
              <div class="chart-plot overview-ghost-days">
                {DAY_HEIGHTS.map((h, i) => (
                  <Bone key={i} kind="column" at={17 + i} height={h} />
                ))}
              </div>
            </div>
          </ChartPanel>
        </div>
        <ChartPanel label="Usage by">
          <BarsGhost widths={BAR_WIDTHS} at={48} />
        </ChartPanel>
        <ChartPanel label="Send length">
          <BarsGhost widths={MODEL_WIDTHS} at={66} wide />
        </ChartPanel>
      </div>
    </div>
  );
}

export function Overview() {
  const answer = overview.value;
  const error = overviewError.value;
  const busy = overviewLoading.value;
  const days = rangeOf(new URLSearchParams(query.value));
  const ranges = OVERVIEW_RANGES.map((r) => ({
    label: `${r} days`,
    on: r === days,
    href: r === 30 ? "/admin" : `/admin?days=${r}`,
  }));
  return (
    <Page
      crumb="Admin"
      title="Overview"
      actions={
        <>
          <RowsFilters label="Range" filters={ranges} />
          <Loaded
            readAt={answer?.readAt ?? null}
            busy={busy}
            error={error}
            onRefresh={() => void loadOverview(days)}
          />
        </>
      }
      error={answer === null && !busy ? error : null}
    >
      <div
        class={`overview${busy && answer ? " overview-stale" : ""}`}
        aria-busy={busy}
      >
        {answer ? <Board answer={answer} /> : <BoardGhost />}
      </div>
    </Page>
  );
}
