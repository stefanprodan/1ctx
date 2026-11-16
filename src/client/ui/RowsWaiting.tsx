// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Rows while a list's first answer loads: bones where a row's lead,
// title, sub and end go, inside the row's own classes, so each row is
// a loaded row's height, wraps as one does on a phone, and nothing
// moves when the rows land.

import type { ComponentChildren } from "preact";
import "./rows.css";
import { Bone, waitRole } from "./Bones.tsx";

// what leads a row: an avatar (a member, an agent, an automation's
// clock), a chevron's icon, or nothing
export type RowsShape = "avatar" | "icon" | "plain";

// the title's and the sub's widths, varied so the bones read as words
const WIDTHS: readonly [number, number][] = [
  [42, 64],
  [56, 48],
  [34, 58],
];

export function RowsWaiting({
  count = 3,
  shape = "avatar",
  label,
  card,
  end,
  sub = true,
}: {
  count?: number;
  shape?: RowsShape;
  // what is loading, for a screen reader: "Loading automations"; none
  // for a piece of a wait whose outer body says it
  label?: string;
  // a card of its own with a head, for a page whose card waits too
  card?: boolean;
  // the meta's own bones, for a row whose end is no short word (the
  // projects' activity strip); a chip when none is given
  end?: ComponentChildren;
  // false for rows of a name alone (a switch's row)
  sub?: boolean;
}) {
  const rows = Array.from({ length: count }, (_, i) => {
    const [title, subWidth] = WIDTHS[i % WIDTHS.length];
    const at = i * 4;
    return (
      <div key={i} class="rows-item" aria-hidden="true">
        <div class="rows-line rows-waiting-line">
          {shape === "avatar" && (
            <Bone kind="avatar" at={at} class="rows-waiting-avatar" />
          )}
          {shape === "icon" && (
            <Bone kind="icon" at={at} class="rows-waiting-icon" />
          )}
          <span class="rows-title">
            <span class="rows-name">
              <Bone kind="line" at={at + 1} width={title} />
            </span>
            {sub && (
              <span class="rows-sub">
                <Bone kind="line" at={at + 2} width={subWidth} />
              </span>
            )}
          </span>
          <span class="rows-meta rows-meta-keep">
            {end ?? <Bone kind="chip" at={at + 3} />}
          </span>
        </div>
      </div>
    );
  });
  if (!card) {
    return (
      <div class="rows-waiting bones-wait" {...waitRole(label)}>
        {rows}
      </div>
    );
  }
  return (
    <div class="card rows-card rows-waiting bones-wait" {...waitRole(label)}>
      <div class="rows-head" aria-hidden="true">
        <Bone kind="label" at={0} />
      </div>
      {rows}
    </div>
  );
}
