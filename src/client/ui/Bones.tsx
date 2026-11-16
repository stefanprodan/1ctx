// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one placeholder a first load draws: a bone where each word and
// mark goes, at its loaded size, pulsing one after another, still
// under reduced motion. Boards, rows, the feed and the shell all draw
// from it.

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
  | "column"
  // a line of text at its font's height, as wide as width says
  | "line"
  // a row's round avatar
  | "avatar"
  // a short word at a row's end: a time, a count, a tag
  | "chip"
  // the feed's state icon
  | "glyph"
  // an activity cell, a square in the grid's own empty colour
  | "cell";

// A placeholder where a word or a mark goes, at its size. at orders
// the pulse, so the bones light one after another.
export function Bone({
  kind,
  at,
  width,
  height,
  class: extra,
  place,
}: {
  kind: BoneKind;
  at: number;
  // shares of the box, in percent
  width?: number;
  height?: number;
  // the owner's class, for the room its loaded shape takes
  class?: string;
  // a grid cell, for a bone that stands in a grid's place
  place?: { column: number; row: number };
}) {
  return (
    <span
      class={`bones-bone bones-bone-${kind}${extra ? ` ${extra}` : ""}`}
      aria-hidden="true"
      style={{
        "--ghost": at,
        ...(width === undefined ? {} : { width: `${width}%` }),
        ...(height === undefined ? {} : { height: `${height}%` }),
        ...(place === undefined
          ? {}
          : { gridColumn: place.column, gridRow: place.row }),
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
