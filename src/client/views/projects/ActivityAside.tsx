// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's recent weeks as an aside section: the Projects page's
// heatmap without its labels, shaded against this project's own days,
// and a line under it for the total or the selected day.

import { useMemo } from "preact/hooks";
import type { DaysUsageResponse } from "../../../shared/api/usage.ts";
import { recentDays } from "../../data/usage.ts";
import { AsideSection } from "../../ui/Split.tsx";
import { activityModel, projectAnswer } from "./Activity.model.ts";
import { ActivityGrid, useDaySelection } from "./Activity.tsx";

function Recent({ answer }: { answer: DaysUsageResponse }) {
  const model = useMemo(() => activityModel(answer), [answer]);
  const { selection, hint, total } = useDaySelection(
    answer,
    model,
    model.columns,
  );
  return (
    <>
      <ActivityGrid
        columns={model.columns}
        offset={0}
        weeks={model.columns.length}
        total={total.sends}
        valueText={hint}
        selection={selection}
        labels={false}
      />
      <p class="split-empty" aria-live="polite">
        {hint}
      </p>
    </>
  );
}

export function ActivityAside({ projectId }: { projectId: string }) {
  const all = recentDays.value;
  // the same object until the answer or the project changes: a new one
  // is a new window, and the selection lets go of its day
  const answer = useMemo(
    () => (all === null ? null : projectAnswer(all, projectId)),
    [all, projectId],
  );
  return (
    <AsideSection label="Activity">
      {answer === null ? (
        <p class="split-empty">Loading</p>
      ) : (
        <Recent answer={answer} />
      )}
    </AsideSection>
  );
}
