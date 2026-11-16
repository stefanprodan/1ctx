// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Rows while a list's first answer loads: bones where a row's lead,
// title, sub and end go, inside the row's own classes, so each row is
// a loaded row's height, wraps as one does on a phone, and nothing
// moves when the rows land.

import "./rows.css";
import { Bone } from "./Bones.tsx";

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
}: {
  count?: number;
  shape?: RowsShape;
  // what is loading, for a screen reader: "Loading automations"
  label: string;
  // a card of its own with a head, for a page whose card waits too
  card?: boolean;
}) {
  const rows = Array.from({ length: count }, (_, i) => {
    const [title, sub] = WIDTHS[i % WIDTHS.length];
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
            <span class="rows-sub">
              <Bone kind="line" at={at + 2} width={sub} />
            </span>
          </span>
          <span class="rows-meta rows-meta-keep">
            <Bone kind="chip" at={at + 3} />
          </span>
        </div>
      </div>
    );
  });
  if (!card) {
    return (
      <div class="rows-waiting bones-wait" role="status" aria-label={label}>
        {rows}
      </div>
    );
  }
  return (
    <div
      class="card rows-card rows-waiting bones-wait"
      role="status"
      aria-label={label}
    >
      <div class="rows-head" aria-hidden="true">
        <Bone kind="label" at={0} />
      </div>
      {rows}
    </div>
  );
}
