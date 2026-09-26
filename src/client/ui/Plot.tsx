// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What runs over time, drawn by uPlot, its one importer: a sparkline
// for a tile and bars over days stacked by part with a key.
//
// A plot lives in a ref: made on mount with a ResizeObserver, fed by a
// second effect, destroyed on unmount. Its colours are tokens read at
// every draw, so a theme flip repaints it in the other theme's. Layout
// effects, since a plain effect would show an empty plot for a frame.

import { useLayoutEffect, useRef } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { theme } from "../app/theme.ts";
import { dayMonth } from "../lib/format.ts";
import "./chart.css";

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// half a day of room at each end, so the first and last day bars are
// whole
const HALF_DAY = 43_200;

// half a step of room at each end, so the first and last bars are whole
const padded = (u: uPlot, min: number, max: number): uPlot.Range.MinMax => {
  const x = u.data[0] as number[];
  const half = x.length > 1 ? (x[1]! - x[0]!) / 2 : HALF_DAY;
  return [min - half, max + half];
};

// a repaint from the data, since redraw(true) pads the padded range again
const repaint = (u: uPlot | null) => u?.setData(u.data);

// A plot made by build on mount and when deps change, sized to its
// box as the box resizes, repainted on a theme flip, destroyed on
// unmount.
function usePlot(build: (el: HTMLDivElement) => uPlot, deps: unknown[]) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const u = build(el);
    plot.current = u;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientWidth !== u.width) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight });
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, deps);
  // read in the render, so a theme flip draws the plot again
  const shade = theme.value;
  useLayoutEffect(() => {
    repaint(plot.current);
  }, [shade]);
  return { box, plot };
}

type Box = [number, number, number, number];

// Bars that remember where uPlot drew them, for a hook to paint over.
function boxedBars(sizeMax: number) {
  const boxes: Box[] = [];
  const paths = uPlot.paths.bars?.({
    size: [0.72, sizeMax],
    radius: [0.18, 0],
    each: (_u, _s, i, left, top, width, height) => {
      boxes[i] = [left, top, width, height];
    },
  });
  return { boxes, paths };
}

// the bar under the cursor painted over in the brand colour
function focusBars(sizeMax: number) {
  const { boxes, paths } = boxedBars(sizeMax);
  const focus = (u: uPlot) => {
    const i = u.cursor.idx;
    const box = i == null ? undefined : boxes[i];
    if (!box) return;
    u.ctx.save();
    u.ctx.fillStyle = token("--brand");
    u.ctx.fillRect(...box);
    u.ctx.restore();
  };
  return { paths, focus };
}

// Every bar but the one under the cursor washed with the card, so a
// stack keeps its parts readable on the day picked.
function fadeBars(sizeMax: number) {
  const { boxes, paths } = boxedBars(sizeMax);
  const fade = (u: uPlot) => {
    const i = u.cursor.idx;
    if (i == null) return;
    u.ctx.save();
    u.ctx.globalAlpha = 0.65;
    u.ctx.fillStyle = token("--card");
    boxes.forEach((box, k) => {
      if (k !== i && box) u.ctx.fillRect(...box);
    });
    u.ctx.restore();
  };
  return { paths, fade };
}

// A sparkline: a line ending in a marked point, or a bar a step. No
// axes: the tile's words hold the numbers. The scale runs from zero to
// top, or to the highest value, or where zoom puts it. Plots of one
// sync key share the cursor, and onCursor hears the point under it, or
// null.
export function Spark({
  kind,
  times,
  values,
  sync,
  onCursor,
  top,
  zoom,
}: {
  kind: "line" | "bars";
  // each point's time, in milliseconds
  times: number[];
  values: number[];
  sync: string;
  onCursor: (index: number | null) => void;
  top?: number;
  zoom?: (min: number, max: number) => [number, number];
}) {
  // the hook reads the latest callback without the plot being rebuilt
  const hear = useRef(onCursor);
  hear.current = onCursor;
  const scale = useRef({ top, zoom });
  scale.current = { top, zoom };

  const { box, plot } = usePlot(
    (el) => {
      const bars = kind === "bars" ? focusBars(6) : null;
      const u = new uPlot(
        {
          width: el.clientWidth,
          height: el.clientHeight,
          padding: [6, 6, 2, 6],
          legend: { show: false },
          cursor: {
            sync: { key: sync, setSeries: false },
            drag: { x: false, y: false },
            y: false,
            points: { show: false },
          },
          scales: {
            x: { time: true, range: bars ? padded : undefined },
            y: {
              range: (_u, min, max) => {
                const { top, zoom } = scale.current;
                return zoom ? zoom(min, max) : [0, top ?? (max || 1)];
              },
            },
          },
          axes: [{ show: false }, { show: false }],
          series: [
            {},
            bars
              ? {
                  stroke: () => token("--heat-2"),
                  fill: () => token("--heat-2"),
                  width: 0,
                  points: { show: false },
                  paths: bars.paths,
                }
              : {
                  stroke: () => token("--heat-2"),
                  width: 2,
                  points: {
                    show: true,
                    size: 8,
                    width: 2,
                    stroke: () => token("--card"),
                    fill: () => token("--brand"),
                    // only the last point, today
                    filter: (u) => [u.data[0].length - 1],
                  },
                },
          ],
          hooks: {
            draw: bars ? [bars.focus] : [],
            setCursor: [
              (u) => {
                hear.current(u.cursor.idx ?? null);
                if (bars) u.redraw(false, false);
              },
            ],
          },
        },
        [[], []],
        el,
      );
      return u;
    },
    [kind, sync],
  );

  useLayoutEffect(() => {
    plot.current?.setData([times.map((t) => t / 1000), values]);
  }, [times, values]);

  return <div class="chart-spark" ref={box} />;
}

export type DaySeries = { label: string; values: number[] };

// a stack's parts, bottom first: the bars' grey, the softer grey
// nearer the card, and the brand colour on top, as the key's swatches
const STACK_TOKENS = ["--heat-3", "--heat-2", "--brand"];

// Bars over days with their parts stacked, bottom first and without a
// gap, on one y axis in the units words gives, and a key above them.
// The day under the cursor keeps its shades while the others fade, and
// onCursor hears it; a sync key shares the cursor with sparklines.
export function DayBars({
  label,
  days,
  series,
  words,
  onCursor,
  sync,
}: {
  // names the table a screen reader reads in place of the plot
  label: string;
  // each day's start, in milliseconds
  days: number[];
  // at most three, bottom first
  series: DaySeries[];
  // an axis value in words
  words: (value: number) => string;
  onCursor: (index: number | null) => void;
  sync?: string;
}) {
  const hear = useRef(onCursor);
  hear.current = onCursor;
  const say = useRef(words);
  say.current = words;
  const parts = series.length;

  const { box, plot } = usePlot(
    (el) => {
      // the tallest bar is the whole stack, drawn first; each lower part
      // is drawn over it, so the top series holds the column's box
      const bars = fadeBars(28);
      const plain = uPlot.paths.bars?.({ size: [0.72, 28], radius: [0, 0] });
      const font = () => `${token("--text-tiny")} ${token("--mono")}`;
      const axis = {
        stroke: () => token("--faint"),
        ticks: { show: false },
        gap: 6,
      };
      const u = new uPlot(
        {
          width: el.clientWidth,
          height: el.clientHeight,
          legend: { show: false },
          cursor: {
            ...(sync ? { sync: { key: sync, setSeries: false } } : {}),
            drag: { x: false, y: false },
            y: false,
            points: { show: false },
          },
          scales: {
            x: { time: true, range: padded },
            y: { range: (_u, _min, max) => [0, max > 0 ? max * 1.1 : 1] },
          },
          axes: [
            {
              ...axis,
              font: font(),
              size: 24,
              grid: { show: false },
              // a tick on a day, never between two, every few days when
              // they would crowd
              splits: (u) => {
                const all = u.data[0] as number[];
                const room = Math.max(
                  1,
                  Math.floor(u.bbox.width / devicePixelRatio / 64),
                );
                const step = Math.max(1, Math.ceil(all.length / room));
                return all.filter((_, i) => (all.length - 1 - i) % step === 0);
              },
              values: (_u, splits) => splits.map((t) => dayMonth(t * 1000)),
            },
            {
              ...axis,
              font: font(),
              size: 52,
              space: 32,
              grid: { stroke: () => token("--line"), width: 1 },
              values: (_u, splits) => splits.map((v) => say.current(v)),
            },
          ],
          series: [
            {},
            ...Array.from({ length: parts }, (_, k) => {
              const name = STACK_TOKENS[parts - 1 - k] ?? "--heat-3";
              return {
                stroke: () => token(name),
                fill: () => token(name),
                width: 0,
                points: { show: false },
                paths: k === 0 ? bars.paths : plain,
              };
            }),
          ],
          hooks: {
            draw: [bars.fade],
            setCursor: [
              (u) => {
                hear.current(u.cursor.idx ?? null);
                u.redraw(false, false);
              },
            ],
          },
        },
        [[], ...Array.from({ length: parts }, () => [] as number[])],
        el,
      );
      return u;
    },
    [parts, sync],
  );

  useLayoutEffect(() => {
    // each part stacked on the ones under it, the whole stack first
    const sums: number[][] = [];
    let run = days.map(() => 0);
    for (const s of series) {
      run = run.map((v, i) => v + (s.values[i] ?? 0));
      sums.push(run);
    }
    plot.current?.setData([days.map((d) => d / 1000), ...sums.reverse()]);
  }, [days, series]);

  return (
    <div class="chart-days">
      <div class="chart-key" aria-hidden="true">
        {series.map((s, k) => (
          <span key={s.label} class="chart-key-item">
            <span class={`chart-swatch chart-key-${k + 1}`} />
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
                {series.map((s) => (
                  <td key={s.label}>{words(s.values[i] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
