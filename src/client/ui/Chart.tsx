// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { shareWidth } from "../lib/format.ts";
import { RowsCard } from "./Rows.tsx";
import "./chart.css";

export function ChartPanel({
  label,
  hint,
  action,
  hintBelow,
  children,
}: {
  label: string;
  hint?: string;
  action?: ComponentChildren;
  // a hint that follows a day plot's pointer: its own line on a phone
  hintBelow?: boolean;
  children: ComponentChildren;
}) {
  return (
    <RowsCard
      label={label}
      hint={hint}
      action={action}
      hintBelow={hintBelow}
      live
      class="chart-panel"
    >
      {children}
    </RowsCard>
  );
}

export type Bar = {
  key: string;
  name: string;
  value: number;
  label: ComponentChildren;
  // the panel's hint while the bar is under the pointer, and its
  // accessible name
  hint: string;
  mono?: boolean;
  faint?: boolean;
  note?: string;
};

// onHover hears a key, not a hint, so a refresh that lands under the
// pointer says the new numbers
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
              {b.note !== undefined && (
                <>
                  {" "}
                  <span class="chart-note">{b.note}</span>
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

// a new key from the caller forgets the bar under the pointer
export function BarsPanel({
  label,
  bars,
  rest,
  none,
  action,
  wide,
  picked,
  onPick,
  children,
}: {
  label: string;
  bars: Bar[];
  rest?: string;
  // said in place of no bars; without, no bars draws nothing
  none?: string;
  action?: ComponentChildren;
  wide?: boolean;
  picked?: string;
  onPick?: (key: string) => void;
  children?: ComponentChildren;
}) {
  const over = useSignal<string | null>(null);
  return (
    <ChartPanel
      label={label}
      hint={bars.find((b) => b.key === over.value)?.hint ?? rest}
      action={action}
    >
      {bars.length > 0 ? (
        <Bars
          bars={bars}
          wide={wide}
          picked={picked}
          onPick={onPick}
          onHover={(key) => {
            over.value = key;
          }}
        />
      ) : (
        none !== undefined && <p class="chart-none">{none}</p>
      )}
      {children}
    </ChartPanel>
  );
}

export function ChartFoot({ children }: { children: ComponentChildren }) {
  return <p class="chart-foot">{children}</p>;
}

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

export function Swatch({ part }: { part: "first" | "second" }) {
  return <span class={`chart-swatch chart-stack-${part}`} />;
}

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
