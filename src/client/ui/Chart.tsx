// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The parts of a board drawn in CSS: a panel with the card head of
// Rows, bars ranked from one baseline, a whole split in two and a
// meter. What runs over days is uPlot, in Plot.tsx.

import type { ComponentChildren } from "preact";
import { shareWidth } from "../lib/format.ts";
import { RowsCard } from "./Rows.tsx";
import "./chart.css";

// A panel of a board: the card head of Rows over a chart's body, as
// tall as the row of the grid it sits in.
export function ChartPanel({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  action?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <RowsCard
      label={label}
      hint={hint}
      action={action}
      live
      class="chart-panel"
    >
      {children}
    </RowsCard>
  );
}

type Bar = {
  key: string;
  name: string;
  value: number;
  label: ComponentChildren;
  // the panel's hint while the bar is under the pointer
  hint: string;
  mono?: boolean;
  // a line that sums others, read apart
  faint?: boolean;
  // what the bar names is gone, its numbers kept: a small word after
  gone?: boolean;
};

// Bars from one baseline, the value at the end of each. With onPick
// each is a button and the picked one is lit. onHover hears the key
// under the pointer or the focus, so the panel reads its hint from the
// answer it holds now; a bar's hint is also its accessible name, the
// words a pointer would show.
export function Bars({
  bars,
  picked,
  onPick,
  onHover,
  wide,
}: {
  bars: Bar[];
  picked?: string;
  onPick?: (key: string) => void;
  onHover: (key: string | null) => void;
  // room for a table's name
  wide?: boolean;
}) {
  const top = Math.max(0, ...bars.map((b) => b.value));
  const List = onPick ? "div" : "ul";
  return (
    <List
      class={`chart-bars${wide ? " chart-bars-wide" : ""}`}
      onPointerLeave={() => onHover(null)}
    >
      {bars.map((b) => {
        const on = onPick !== undefined && b.key === picked;
        const cls = `chart-bar${onPick ? " chart-bar-pick" : ""}${on ? " chart-bar-on" : ""}${
          b.faint ? " chart-bar-faint" : ""
        }`;
        const width = `${Math.max(0.6, top > 0 ? (b.value / top) * 100 : 0).toFixed(2)}%`;
        const inner = (
          <>
            <span class={`chart-bar-name${b.mono ? " chart-mono" : ""}`}>
              {b.name}
              {b.gone && (
                <>
                  {" "}
                  <span class="chart-gone">deleted</span>
                </>
              )}
            </span>
            <span class="chart-bar-track">
              <span class="chart-bar-fill" style={{ width }} />
            </span>
            <span class="chart-value">{b.label}</span>
          </>
        );
        return onPick ? (
          <button
            key={b.key}
            type="button"
            class={cls}
            aria-pressed={on}
            aria-label={b.hint}
            onClick={() => onPick(b.key)}
            onPointerEnter={() => onHover(b.key)}
            onFocus={() => onHover(b.key)}
            onBlur={() => onHover(null)}
          >
            {inner}
          </button>
        ) : (
          <li
            key={b.key}
            class={cls}
            aria-label={b.hint}
            onPointerEnter={() => onHover(b.key)}
          >
            {inner}
          </li>
        );
      })}
    </List>
  );
}

// the words under a panel's bars: what they add up to
export function ChartFoot({ children }: { children: ComponentChildren }) {
  return <p class="chart-foot">{children}</p>;
}

// One bar split in two, the first part dark and the second light; the
// label says both for a screen reader.
export function Stack({
  first,
  second,
  label,
}: {
  first: number;
  second: number;
  label: string;
}) {
  const whole = first + second;
  const width = (n: number) =>
    `${whole > 0 ? ((n / whole) * 100).toFixed(2) : "0"}%`;
  return (
    <div class="chart-stack-wrap">
      <div class="chart-stack" role="img" aria-label={label}>
        {first > 0 && (
          <span class="chart-stack-first" style={{ width: width(first) }} />
        )}
        {second > 0 && (
          <span class="chart-stack-second" style={{ width: width(second) }} />
        )}
      </div>
    </div>
  );
}

// the small square that names a part of the split
export function Swatch({ part }: { part: "first" | "second" }) {
  return <span class={`chart-swatch chart-stack-${part}`} />;
}

// A share as a bar under its number, a row's size against the largest.
export function Meter({ share }: { share: number }) {
  return (
    <span class="meter" aria-hidden="true">
      <span
        class="meter-fill chart-meter-fill"
        style={{ width: shareWidth(share) }}
      />
    </span>
  );
}
