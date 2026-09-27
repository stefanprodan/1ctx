// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The instance at a glance, headed Monitor / Live. The first tiles are
// the server's load, polled while the page is on screen
// (OverviewNow.tsx); the head says when they were read, or that a poll
// failed, with Refresh, as Storage's. Needs attention lists what an
// admin should fix, each row opening the page that fixes it. Stats is
// four tiles on one cursor over 30 days, 90 days or all, the
// breakdowns being on Usage. The page keeps
// itself current while it is seen (watchOverview()); the first load
// draws the board in bones, and a failed read keeps the last answer
// faded and says since when.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import {
  OVERVIEW_RANGES,
  type OverviewRange,
  type OverviewResponse,
} from "../../../shared/api/admin.ts";
import {
  attention,
  attentionError,
  overview,
  overviewError,
  overviewLoading,
  overviewRange,
  pickOverviewRange,
  refreshOverview,
  serverLoad,
  serverLoadError,
  watchOverview,
} from "../../data/overview.ts";
import type { Failure } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { Loaded } from "../../ui/Loaded.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { RowsFilters } from "../../ui/RowsControls.tsx";
import { ActivityPanel, DaysTiles, LengthPanel } from "./Days.tsx";
import { attentionRow, buildLine } from "./Overview.model.ts";
import { BoardRow, NowRow, OverviewGhost, Trouble } from "./OverviewNow.tsx";
import "./overview.css";

const DAYS_SYNC = "overview";

function Attention() {
  const now = useNow(60_000);
  const answer = attention.value;
  const error = attentionError.value;
  if (answer === null) {
    return error ? (
      <RowsCard label="Needs attention" class="overview-stale">
        <RowsNote>Did not load.</RowsNote>
      </RowsCard>
    ) : null;
  }
  const rows = answer.items.map((item) => attentionRow(item, now));
  return (
    <RowsCard
      label="Needs attention"
      count={rows.length > 0 ? String(rows.length) : undefined}
      class={error ? "overview-stale" : undefined}
    >
      {rows.length === 0 ? (
        <RowsNote>Nothing needs attention.</RowsNote>
      ) : (
        rows.map((row) => (
          <RowsGo key={row.key} href={row.href}>
            <RowsAvatar>
              <Icon name={row.icon} size={14} />
            </RowsAvatar>
            <RowsTitle name={row.name} sub={row.line} mono bad />
            <RowsMeta>{row.what}</RowsMeta>
          </RowsGo>
        ))
      )}
    </RowsCard>
  );
}

const RANGE_LABELS: Record<OverviewRange, string> = {
  "30d": "30d",
  "90d": "90d",
  all: "All",
};

function Stats({
  answer,
  error,
}: {
  answer: OverviewResponse | null;
  error: Failure | null;
}) {
  const day = useSignal<number | null>(null);
  const range = overviewRange.value;
  const filters = OVERVIEW_RANGES.map((r) => ({
    label: RANGE_LABELS[r],
    on: range === r,
    onPick: () => {
      day.value = null;
      pickOverviewRange(r);
    },
  }));
  return (
    <>
      <BoardRow
        label="Stats"
        stale={answer !== null && error !== null}
        note={answer && <Trouble error={error} at={answer.readAt} />}
        action={<RowsFilters label="Stats over" filters={filters} />}
      />
      {answer ? (
        // another range keeps the last one faded until it lands
        <div class={answer.range !== range ? "overview-stale" : undefined}>
          <DaysTiles
            days={answer.days}
            totals={answer.totals}
            day={day}
            sync={DAYS_SYNC}
            people={{
              active: answer.activeUsers,
              users: answer.instance.users,
            }}
          />
          <div class="chart-grid overview-charts">
            <ActivityPanel
              days={answer.days}
              totals={answer.totals}
              day={day}
              sync={DAYS_SYNC}
            />
            <LengthPanel
              days={answer.days}
              lengths={answer.turnLength}
              day={day}
              sync={DAYS_SYNC}
            />
          </div>
        </div>
      ) : (
        <OverviewGhost at={16} />
      )}
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
      // the zone's own page: the step names the zone, no link to itself
      steps={[{ label: "Monitor" }]}
      title="Live"
      actions={
        // when the live tiles were last read; Refresh reads it all again
        <Loaded
          readAt={serverLoad.value?.at ?? null}
          busy={overviewLoading.value}
          error={serverLoadError.value}
          onRefresh={() => void refreshOverview()}
        />
      }
      error={answer === null && !busy ? error : null}
    >
      <div class="chart-board" aria-busy={answer === null && busy}>
        <NowRow />
        <Attention />
        {/* a failed read keeps the last answer, faded */}
        <div class={`overview-past${answer && error ? " overview-stale" : ""}`}>
          <Stats answer={answer} error={error} />
        </div>
        {answer && (
          <p class="chart-facts">
            {/* the uptime runs on with the load; the answer is kept */}
            {buildLine(answer.instance, serverLoad.value?.at ?? answer.readAt)}
          </p>
        )}
      </div>
    </Page>
  );
}
