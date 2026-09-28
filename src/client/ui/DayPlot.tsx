// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Ref } from "preact";
import { dayMonth } from "../lib/format.ts";
import "./chart.css";

// one series needs no key: the panel's label names it
export function DayPlot({
  label,
  days,
  series,
  swatches,
  words,
  box,
}: {
  label: string;
  days: number[];
  series: { label: string; values: (number | null)[] }[];
  // a colour token a series, in the series' order
  swatches: readonly string[];
  words: (value: number) => string;
  box: Ref<HTMLDivElement>;
}) {
  return (
    <div class="chart-days">
      {series.length > 1 && (
        <div class="chart-key" aria-hidden="true">
          {series.map((s, k) => (
            <span key={s.label} class="chart-key-item">
              <span
                class="chart-swatch"
                style={{ background: `var(${swatches[k] ?? "--heat-3"})` }}
              />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div class="chart-plot" ref={box} aria-hidden="true" />
      <div class="chart-table">
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {series.map((s) => (
                <th key={s.label} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d}>
                <th scope="row">{dayMonth(d)}</th>
                {series.map((s) => {
                  const v = s.values[i] ?? null;
                  return <td key={s.label}>{v === null ? "" : words(v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
