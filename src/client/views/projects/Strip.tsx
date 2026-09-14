// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project row's last two weeks on the heatmap's levels, the same
// squares at every width. Today goes unmarked, as on the heatmap: an
// outlined square down every row is noise.

import type { DaysUsageResponse } from "../../../shared/api/usage.ts";
import { projectStrip, stripAriaLabel } from "./Activity.model.ts";
import "./activity.css";

export function Strip({
  answer,
  projectId,
  population,
}: {
  answer: DaysUsageResponse;
  projectId: string;
  population: readonly number[];
}) {
  const cells = projectStrip(answer, projectId, population);
  return (
    <span class="activity-strip" role="img" aria-label={stripAriaLabel(cells)}>
      {cells.map((cell) => (
        <span
          key={cell.day}
          class={`activity-cell activity-level-${cell.level}`}
        />
      ))}
    </span>
  );
}
