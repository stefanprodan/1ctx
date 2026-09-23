// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The bones a board shows while its first answer loads: a placeholder
// where each word and mark goes, at its loaded size, pulsing one after
// another as the feed's ghost rows do, still under reduced motion.

import "./bones.css";

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
  | "stack"
  | "column";

// A placeholder where a word or a mark goes, at its size. at orders
// the pulse, so the bones light one after another as the feed's do.
export function Bone({
  kind,
  at,
  width,
  height,
}: {
  kind: BoneKind;
  at: number;
  // shares of the box, in percent
  width?: number;
  height?: number;
}) {
  return (
    <span
      class={`bones-bone bones-bone-${kind}`}
      style={{
        "--ghost": at,
        ...(width === undefined ? {} : { width: `${width}%` }),
        ...(height === undefined ? {} : { height: `${height}%` }),
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
