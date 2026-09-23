// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The parts of a board: a panel with the card head of Rows, uPlot for
// what changes over time, and plain CSS for what is ranked (bars from
// one baseline), what splits a whole and the bones a panel shows while
// it loads. This is uPlot's one importer.
//
// A plot lives in a ref: made on mount with a ResizeObserver, fed by a
// second effect, destroyed on unmount. Its colours are tokens read at
// every draw, so a theme flip repaints it in the other theme's. Layout
// effects, since a plain effect would show an empty plot for a frame.

import type { ComponentChildren } from "preact";
import { useId, useLayoutEffect, useRef } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { theme } from "../app/theme.ts";
import "./chart.css";

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// half a day of room at each end, so the first and last day bars are
// whole
const HALF_DAY = 43_200;

// Bars that remember where uPlot drew them, so the one under the
// cursor can be painted over in the brand colour.
function focusBars(sizeMax: number) {
  const boxes: [number, number, number, number][] = [];
  const paths = uPlot.paths.bars?.({
    size: [0.72, sizeMax],
    radius: [0.18, 0],
    each: (_u, _s, i, left, top, width, height) => {
      boxes[i] = [left, top, width, height];
    },
  });
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

// A sparkline over days: a line ending in a marked point, or a bar a
// day. No axes: the tile's words hold the numbers. Plots of one sync
// key share the cursor, and onCursor hears the day under it, or null.
export function Spark({
  kind,
  days,
  values,
  sync,
  onCursor,
}: {
  kind: "line" | "bars";
  // each day's start, in milliseconds
  days: number[];
  values: number[];
  sync: string;
  onCursor: (index: number | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  // the hook reads the latest callback without the plot being rebuilt
  const hear = useRef(onCursor);
  hear.current = onCursor;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
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
          x: {
            time: true,
            range: bars
              ? (_u, min, max) => [min - HALF_DAY, max + HALF_DAY]
              : undefined,
          },
          y: bars ? { range: (_u, _min, max) => [0, max || 1] } : {},
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
  }, [kind, sync]);

  // read in the render, so a theme flip draws the plot again
  const shade = theme.value;
  useLayoutEffect(() => {
    plot.current?.redraw(true);
  }, [shade]);

  useLayoutEffect(() => {
    plot.current?.setData([days.map((d) => d / 1000), values]);
  }, [days, values]);

  return <div class="chart-spark" ref={box} />;
}

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
  const id = useId();
  return (
    <section class="card rows-card chart-panel" aria-labelledby={id}>
      <div class="rows-head">
        <span class="label" id={id}>
          {label}
        </span>
        {hint && (
          <span class="rows-hint" aria-live="polite">
            {hint}
          </span>
        )}
        {action}
      </div>
      {children}
    </section>
  );
}

export type Bar = {
  key: string;
  name: string;
  value: number;
  label: ComponentChildren;
  // the panel's hint while the bar is under the pointer
  hint: string;
  mono?: boolean;
  // a line that sums others, read apart
  faint?: boolean;
};

// Bars from one baseline, the value at the end of each. With onPick
// each is a button and the picked one is lit.
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
  onHover: (hint: string | null) => void;
  // room for a table's name
  wide?: boolean;
}) {
  const top = Math.max(0, ...bars.map((b) => b.value));
  return (
    <div
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
            onClick={() => onPick(b.key)}
            onPointerEnter={() => onHover(b.hint)}
            onFocus={() => onHover(b.hint)}
            onBlur={() => onHover(null)}
          >
            {inner}
          </button>
        ) : (
          <div key={b.key} class={cls} onPointerEnter={() => onHover(b.hint)}>
            {inner}
          </div>
        );
      })}
    </div>
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
  const width = `${Math.min(100, Math.max(0, share * 100)).toFixed(1)}%`;
  return (
    <span class="meter" aria-hidden="true">
      <span class="meter-fill chart-meter-fill" style={{ width }} />
    </span>
  );
}

export type BoneKind =
  | "label"
  | "figure"
  | "sub"
  | "trend"
  | "name"
  | "fill"
  | "value"
  | "icon"
  | "title"
  | "meter"
  | "stack";

// A placeholder where a word or a mark goes, at its size. at orders
// the pulse, so the bones light one after another as the feed's do.
export function Bone({
  kind,
  at,
  width,
}: {
  kind: BoneKind;
  at: number;
  width?: number;
}) {
  return (
    <span
      class={`chart-bone chart-bone-${kind}`}
      style={{
        "--ghost": at,
        ...(width === undefined ? {} : { width: `${width}%` }),
      }}
    />
  );
}

// the bar rows while they load
export function BarsGhost({
  widths,
  at,
  wide,
}: {
  widths: number[];
  at: number;
  wide?: boolean;
}) {
  return (
    <div class={`chart-bars${wide ? " chart-bars-wide" : ""}`}>
      {widths.map((w, i) => (
        <div key={i} class="chart-bar">
          <Bone kind="name" at={at + i * 3} />
          <span class="chart-bar-track">
            <Bone kind="fill" at={at + i * 3 + 1} width={w} />
          </span>
          <Bone kind="value" at={at + i * 3 + 2} />
        </div>
      ))}
    </div>
  );
}
