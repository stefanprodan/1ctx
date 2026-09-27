// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a day plot draws around uPlot's canvas: the key over it and the
// table a screen reader reads in its place. Plot.tsx fills the box.

import type { Ref } from "preact";
import { dayMonth } from "../lib/format.ts";
import "./chart.css";

// the key over a day plot, a swatch class a series, and the table a
// screen reader reads in its place
export function DayPlot({
  label,
  days,
  series,
  swatch,
  words,
  box,
}: {
  label: string;
  days: number[];
  series: { label: string; values: (number | null)[] }[];
  swatch: (k: number) => string;
  words: (value: number) => string;
  box: Ref<HTMLDivElement>;
}) {
  return (
    <div class="chart-days">
      <div class="chart-key" aria-hidden="true">
        {series.map((s, k) => (
          <span key={s.label} class="chart-key-item">
            <span class={`chart-swatch ${swatch(k)}`} />
            {s.label}
          </span>
        ))}
      </div>
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
