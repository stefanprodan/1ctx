// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Activity card and a row's strip render the model: the grid with
// its live hint, and a row's last two weeks.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  recentDays,
  recentDaysFailed,
} from "../../../src/client/data/usage.ts";
import { activityModel } from "../../../src/client/views/projects/Activity.model.ts";
import {
  Activity,
  ActivityGhost,
} from "../../../src/client/views/projects/Activity.tsx";
import { ActivityAside } from "../../../src/client/views/projects/ActivityAside.tsx";
import {
  Strip,
  StripGhost,
} from "../../../src/client/views/projects/Strip.tsx";
import type { DaysUsageResponse } from "../../../src/shared/api/usage.ts";

// a year's answer: 53 weeks from Monday 8 September 2025 to Tuesday
// 8 September 2026
function answer(): DaysUsageResponse {
  const days: string[] = [];
  const start = Date.UTC(2025, 8, 8);
  for (let i = 0; i < 52 * 7 + 2; i++) {
    days.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  const usage = days.map((_, i) => ({
    sends: i % 5,
    tokens: (i % 5) * 1000,
  }));
  return {
    since: 0,
    until: 1,
    days,
    total: { sends: 700, tokens: 700_000 },
    projects: [{ projectId: "p1", usage }],
  };
}

describe("the Activity card", () => {
  test("draws the last 26 weeks of a year before it measures", () => {
    const body = answer();
    const html = render(<Activity answer={body} model={activityModel(body)} />);
    // 25 whole weeks and today's two days, the first of them a Monday
    const shown = body.projects[0].usage.slice(-(25 * 7 + 2));
    const sends = shown.reduce((n, day) => n + day.sends, 0);
    expect(html.match(/class="activity-grid"/g)).toHaveLength(1);
    expect(html.match(/data-index/g)).toHaveLength(25 * 7 + 2);
    expect(html).toContain(`data-index="${27 * 7}"`);
    expect(html).not.toContain(`data-index="${27 * 7 - 1}"`);
    // a part of the window sums its days rather than the whole total
    expect(html).toContain(`aria-label="${sends} turns in 26 weeks"`);
    expect(html).toContain(`>${sends} turns · ${sends}K tokens<`);
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("activity-today");
    expect(html).toContain(">Mon<");
    expect(html).toContain("activity-month");
    // no month label spans past the last week
    for (const [, start, span] of html.matchAll(
      /grid-column:(\d+) \/ span (\d+)/g,
    )) {
      expect(Number(start) + Number(span) - 2).toBeLessThanOrEqual(26);
    }
  });

  test("its ghost draws the same half year of cells with no day", () => {
    const html = render(<ActivityGhost />);
    expect(html).toContain(">Activity<");
    expect(html).toContain('aria-label="Loading activity"');
    expect(html.match(/activity-ghost/g)).toHaveLength(26 * 7);
    expect(html).not.toContain("data-index");
    expect(html).not.toContain('role="slider"');
    // the labels the loaded card draws, so it lands where the ghost was
    expect(html).toContain(">Mon<");
    expect(html).toContain("activity-month");
    expect(html).toContain("activity-legend");
  });

  test("a strip draws the last 14 days", () => {
    const body = answer();
    const html = render(
      <Strip
        answer={body}
        projectId="p1"
        population={activityModel(body).population}
      />,
    );
    expect(html.match(/activity-cell/g)).toHaveLength(14);
    expect(html).toContain('aria-label="');
    expect(html).toContain("in 14 days");
  });

  test("a strip's ghost is 14 squares with no levels", () => {
    const html = render(<StripGhost />);
    expect(html.match(/activity-ghost/g)).toHaveLength(14);
    expect(html).not.toContain("activity-level");
    expect(html).toContain('aria-hidden="true"');
  });

  test.serial("a project's aside draws its own recent weeks, no labels", () => {
    const days: string[] = [];
    for (let i = 0; i < 15 * 7 + 1; i++) {
      days.push(
        new Date(Date.UTC(2026, 5, 1) + i * 86_400_000)
          .toISOString()
          .slice(0, 10),
      );
    }
    recentDays.value = {
      since: 0,
      until: 1,
      days,
      total: { sends: 50, tokens: 2_000_000 },
      projects: [
        {
          projectId: "p1",
          usage: days.map((_, i) => ({
            sends: i === 0 ? 8 : 0,
            tokens: i === 0 ? 400_000 : 0,
          })),
        },
        {
          projectId: "p2",
          usage: days.map((_, i) => ({ sends: i === 1 ? 42 : 0, tokens: 0 })),
        },
      ],
    };
    const html = render(<ActivityAside projectId="p1" />);
    expect(html).toContain(">Activity<");
    expect(html).toContain('class="activity-grid activity-grid-compact"');
    expect(html.match(/data-index/g)).toHaveLength(days.length);
    expect(html).not.toContain("activity-month");
    expect(html).not.toContain("activity-weekday");
    // this project's turns, not the answer's total over every project
    expect(html).toContain('aria-label="8 turns in 16 weeks"');
    expect(html).toContain(">8 turns · 400K tokens<");
    // its busiest day is its own top level
    expect(html).toContain(
      'data-index="0" class="activity-cell activity-level-4"',
    );
    recentDays.value = null;
    const ghost = render(<ActivityAside projectId="p1" />);
    expect(ghost).toContain('aria-label="Loading activity"');
    expect(ghost).toContain('class="activity-grid activity-grid-compact"');
    expect(ghost.match(/activity-ghost/g)).toHaveLength(16 * 7);
    expect(ghost).not.toContain("activity-weekday");
    recentDaysFailed.value = true;
    expect(render(<ActivityAside projectId="p1" />)).toBe("");
    recentDaysFailed.value = false;
  });
});
