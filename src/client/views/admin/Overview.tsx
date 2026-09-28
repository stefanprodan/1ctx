// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import {
  OVERVIEW_RANGES,
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
import { CodeTag } from "../../ui/CodeTag.tsx";
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
import { attentionRow, buildLine, staleWords } from "./Overview.model.ts";
import { NowRow, OverviewGhost } from "./OverviewNow.tsx";
import "./overview.css";

const DAYS_SYNC = "overview";

function BoardRow({
  label,
  note,
  stale,
  action,
}: {
  label: string;
  note?: ComponentChildren;
  stale?: boolean;
  action?: ComponentChildren;
}) {
  return (
    <div class={`overview-section${stale ? " overview-section-stale" : ""}`}>
      <span class="label">{label}</span>
      {note && <span class="overview-section-note">{note}</span>}
      {action && <span class="overview-section-action">{action}</span>}
    </div>
  );
}

// nothing while the row keeps up
function Trouble({ error, at }: { error: Failure | null; at: number | null }) {
  if (error === null) return null;
  return (
    <>
      {staleWords(at)}
      <CodeTag status={error.status} />
    </>
  );
}

function Attention() {
  const now = useNow(60_000);
  const answer = attention.value;
  const error = attentionError.value;
  if (answer === null) {
    return error ? (
      <RowsCard label="Needs attention" class="chart-stale">
        <RowsNote>Did not load.</RowsNote>
      </RowsCard>
    ) : null;
  }
  const rows = answer.items.map((item) => attentionRow(item, now));
  return (
    <RowsCard
      label="Needs attention"
      count={rows.length > 0 ? String(rows.length) : undefined}
      class={error ? "chart-stale" : undefined}
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
    label: r === "all" ? "All" : r,
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
        <div class={answer.range !== range ? "chart-stale" : undefined}>
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
      // the zone's own page, so no link to itself
      steps={[{ label: "Monitor" }]}
      title="Live"
      actions={
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
        <div
          class={`overview-past${answer && error ? " overview-past-stale" : ""}`}
        >
          <Stats answer={answer} error={error} />
        </div>
        {answer && (
          <p class="chart-facts">
            {/* the uptime runs on with the live load, not the kept answer */}
            {buildLine(answer.instance, serverLoad.value?.at ?? answer.readAt)}
          </p>
        )}
      </div>
    </Page>
  );
}
