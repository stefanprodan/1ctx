// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A row of stat tiles: each a label, a figure with its unit, a line
// under it and, at its foot, a trend or a meter. Four across, two by
// two under 1100. A tile while its answer loads keeps its size, with
// bones where the words go.

import type { ComponentChildren } from "preact";
import { Bone } from "./Bones.tsx";
import "./tiles.css";

export function Tiles({ children }: { children: ComponentChildren }) {
  return <div class="tiles">{children}</div>;
}

export function Tile({
  label,
  figure,
  unit,
  sub,
  children,
}: {
  label: string;
  figure: string;
  unit?: string;
  sub: string;
  // the foot: a TilePlot or a TileMeter
  children?: ComponentChildren;
}) {
  return (
    <section class="card tiles-tile" aria-label={label}>
      <span class="label">{label}</span>
      <span class="tiles-figure">
        {figure}
        {unit && <span class="tiles-unit">{unit}</span>}
      </span>
      <span class="tiles-sub" aria-live="polite">
        {sub}
      </span>
      {children}
    </section>
  );
}

// the box a sparkline fills
export function TilePlot({
  label,
  children,
}: {
  label: string;
  children: ComponentChildren;
}) {
  return (
    <div class="tiles-plot" role="img" aria-label={label}>
      {children}
    </div>
  );
}

// a share of a whole, 0 to 1
export function TileMeter({ share }: { share: number }) {
  const width = `${Math.min(100, Math.max(0, share * 100)).toFixed(1)}%`;
  return (
    <span class="meter tiles-meter" aria-hidden="true">
      <span class="meter-fill tiles-meter-fill" style={{ width }} />
    </span>
  );
}

// a tile while it loads; at is where its bones start in the pulse
export function TileGhost({ at }: { at: number }) {
  return (
    <section class="card tiles-tile tiles-ghost" aria-hidden="true">
      <Bone kind="label" at={at} />
      <Bone kind="figure" at={at + 1} />
      <Bone kind="sub" at={at + 2} />
      <Bone kind="trend" at={at + 3} />
    </section>
  );
}
