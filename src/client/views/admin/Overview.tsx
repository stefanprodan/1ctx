// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The instance at a glance, in three rows by time. Now is the server's
// load, polled while the page is on screen (OverviewNow.tsx). Last 30
// days is four tiles on one cursor, the tokens of each day stacked by
// kind, the usage by project or agent and how long each model's turns
// take. All time is one card of figures and the instance's counts. The
// page keeps itself current while it is seen (watchOverview()); the
// first load draws the board in bones, and a failed read keeps the last
// answer faded and says since when.

import { useSignal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useMemo } from "preact/hooks";
import {
  type OverviewResponse,
  USAGE_BY,
  type UsageBy,
} from "../../../shared/api/admin.ts";
import {
  overview,
  overviewError,
  overviewLoading,
  serverLoad,
  watchOverview,
} from "../../data/overview.ts";
import { count, type Failure } from "../../lib/format.ts";
import { BarsGhost, Bone } from "../../ui/Bones.tsx";
import { Bars, ChartFoot, ChartPanel } from "../../ui/Chart.tsx";
import { Page } from "../../ui/Page.tsx";
import { DayBars, type DaySeries, Spark } from "../../ui/Plot.tsx";
import { RowsFilters } from "../../ui/Rows.tsx";
import { Tile, TilePlot, Tiles } from "../../ui/Tiles.tsx";
import {
  allCells,
  buildLine,
  costTile,
  databaseWords,
  dayTokensHint,
  instanceParts,
  lengthBars,
  runsTile,
  sinceWords,
  tokensHint,
  tokensOf,
  tokensTile,
  turnsTile,
  usageBars,
} from "./Overview.model.ts";
import { NowRow, Section, TilesGhost, Trouble } from "./OverviewNow.tsx";
import "./overview.css";

const DAYS_SYNC = "overview";

const BY_LABELS: Record<UsageBy, string> = {
  projects: "Projects",
  agents: "Agents",
};

function DaysTiles({
  answer,
  day,
}: {
  answer: OverviewResponse;
  day: { value: number | null };
}) {
  const { days, totals } = answer;
  const series = useMemo(
    () => ({
      starts: days.map((d) => d.start),
      turns: days.map((d) => d.turns),
      runs: days.map((d) => d.runs),
      tokens: days.map((d) => tokensOf(d)),
      // flat at zero where no provider priced a round
      cost: days.map((d) => d.cost ?? 0),
    }),
    [days],
  );
  const onCursor = (index: number | null) => {
    day.value = index;
  };
  const at = day.value === null ? null : (days[day.value] ?? null);
  const turns = turnsTile(totals, at);
  const runs = runsTile(totals, at);
  const tokens = tokensTile(totals, at);
  const cost = costTile(totals, at);
  const spark = (kind: "line" | "bars", values: number[]) => (
    <Spark
      kind={kind}
      times={series.starts}
      values={values}
      sync={DAYS_SYNC}
      onCursor={onCursor}
    />
  );
  return (
    <Tiles>
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
      <Tile label="Tokens" figure={tokens.figure} sub={tokens.sub}>
        <TilePlot label="Tokens per day">
          {spark("line", series.tokens)}
        </TilePlot>
      </Tile>
      <Tile label="Cost" figure={cost.figure} sub={cost.sub}>
        <TilePlot label="Cost per day">{spark("line", series.cost)}</TilePlot>
      </Tile>
    </Tiles>
  );
}

const NO_TURNS = "No turns in the last 30 days";

function TokensPanel({
  answer,
  day,
}: {
  answer: OverviewResponse;
  day: { value: number | null };
}) {
  const { days, totals } = answer;
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
    >
      {any ? (
        <DayBars
          label="Tokens per day"
          days={starts}
          series={series}
          words={(v) => (v === 0 ? "0" : count(v))}
          sync={DAYS_SYNC}
          onCursor={(i) => {
            day.value = i;
          }}
        />
      ) : (
        <p class="overview-none">{NO_TURNS}</p>
      )}
    </ChartPanel>
  );
}

function UsagePanel({ answer }: { answer: OverviewResponse }) {
  const kind = useSignal<UsageBy>("projects");
  const over = useSignal<string | null>(null);
  const bars = usageBars(kind.value, answer.by[kind.value]);
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
      label="Usage"
      hint={bars.find((b) => b.key === over.value)?.hint}
      action={<RowsFilters label="Usage by" filters={filters} />}
    >
      {bars.length === 0 ? (
        <p class="overview-none">{NO_TURNS}</p>
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

function LengthPanel({ answer }: { answer: OverviewResponse }) {
  const over = useSignal<string | null>(null);
  const bars = lengthBars(answer.lengths);
  return (
    <ChartPanel
      label="Turn length"
      hint={bars.find((b) => b.key === over.value)?.hint ?? "median"}
    >
      {bars.length === 0 ? (
        <p class="overview-none">{NO_TURNS}</p>
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

function AllTime({ answer }: { answer: OverviewResponse }) {
  return (
    <>
      <Section label="All time" note={sinceWords(answer.all.since)} />
      <section class="card overview-all" aria-label="All time">
        <div class="overview-totals">
          {allCells(answer.all).map((cell) => (
            <div key={cell.label} class="overview-total">
              <span class="label">{cell.label}</span>
              <span class="overview-total-figure">
                {cell.figure}
                {"unit" in cell && (
                  <span class="overview-total-unit">{cell.unit}</span>
                )}
              </span>
              <span class="overview-total-sub">{cell.sub}</span>
            </div>
          ))}
        </div>
        <ChartFoot>
          {instanceParts(answer.instance).map((part) => (
            <Fragment key={part}>
              <span class="overview-part">{part} ·</span>{" "}
            </Fragment>
          ))}
          <a class="overview-facts-link overview-part" href="/admin/storage">
            {databaseWords(answer.instance.databaseBytes)}
          </a>
        </ChartFoot>
      </section>
    </>
  );
}

function Past({
  answer,
  error,
}: {
  answer: OverviewResponse;
  error: Failure | null;
}) {
  // the day under the cursor, shared by the tiles and the tokens chart
  const day = useSignal<number | null>(null);
  return (
    <>
      <Section
        label="Last 30 days"
        stale={error !== null}
        note={<Trouble error={error} at={answer.readAt} />}
      />
      <DaysTiles answer={answer} day={day} />
      <div class="overview-grid">
        <div class="overview-wide">
          <TokensPanel answer={answer} day={day} />
        </div>
        <UsagePanel answer={answer} />
        <LengthPanel answer={answer} />
      </div>
      <AllTime answer={answer} />
    </>
  );
}

const BAR_WIDTHS = [100, 62, 40, 26, 14];
const LENGTH_WIDTHS = [100, 48, 30, 12];
const DAY_HEIGHTS = [
  38, 60, 52, 41, 20, 14, 62, 60, 60, 50, 48, 18, 34, 54, 64, 76, 56, 42, 12,
  18, 64, 62, 58, 96, 50, 20, 10, 46, 64, 70,
];

// the last two rows while their first answer loads, in their shape
function PastGhost() {
  return (
    <>
      <Section label="Last 30 days" />
      <TilesGhost at={16} />
      <div class="overview-grid overview-ghost" aria-hidden="true">
        <div class="overview-wide">
          <ChartPanel label="Tokens per day">
            <div class="chart-days">
              <div class="chart-key">
                <Bone kind="title" at={32} width={30} />
              </div>
              <div class="chart-plot overview-ghost-days">
                {DAY_HEIGHTS.map((h, i) => (
                  <Bone key={i} kind="column" at={33 + i} height={h} />
                ))}
              </div>
            </div>
          </ChartPanel>
        </div>
        <ChartPanel label="Usage">
          <BarsGhost widths={BAR_WIDTHS} at={64} wide />
        </ChartPanel>
        <ChartPanel label="Turn length">
          <BarsGhost widths={LENGTH_WIDTHS} at={80} wide />
        </ChartPanel>
      </div>
    </>
  );
}

export function Overview() {
  useEffect(() => watchOverview(), []);
  const answer = overview.value;
  const error = overviewError.value;
  const busy = overviewLoading.value;
  return (
    <Page
      crumb="Admin"
      title="Overview"
      error={answer === null && !busy ? error : null}
    >
      <div class="overview" aria-busy={answer === null && busy}>
        <NowRow />
        {/* a failed read keeps the last answer, faded */}
        <div class={`overview-past${answer && error ? " overview-stale" : ""}`}>
          {answer ? <Past answer={answer} error={error} /> : <PastGhost />}
        </div>
        {answer && (
          <p class="overview-facts">
            {/* the uptime runs on with the load; the answer is kept */}
            {buildLine(answer.instance, serverLoad.value?.at ?? answer.readAt)}
          </p>
        )}
      </div>
    </Page>
  );
}
