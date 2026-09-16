// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The marks of the services a provider can be, drawn in the current
// colour so they sit in a tile like the icons. OpenRouter's is the
// glyph of its official logo (openrouter.ai/press), the wordmark left
// out; the box is the glyph's own bounds, squared. Gemini's is the
// spark, as Simple Icons traces it (CC0), in its 24 box.

import type { Wire } from "../../shared/words.ts";

const OPENROUTER =
  "M303.9475,17.19926c42.79734,0,77.48933,34.69327,77.48933,77.48933s-34.69199,77.48933-77.48933,77.48933l76.86166,76.86244c9.76367,9.76313,2.84903,26.45667-10.95697,26.45667h-220.88335c-71.32686,0-129.14889-57.82202-129.14889-129.14889S77.64197,17.19926,148.96884,17.19926h154.97866ZM148.96884,68.85881c-42.79607,0-77.48933,34.69327-77.48933,77.48933s34.69327,77.48933,77.48933,77.48933,77.48933-34.69327,77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z";

const GEMINI =
  "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81";

const MARKS: Partial<Record<Wire, { d: string; box: string }>> = {
  openrouter: { d: OPENROUTER, box: "19.8 -34.45 361.6 361.6" },
  gemini: { d: GEMINI, box: "0 0 24 24" },
};

// whether the wire has a mark; a server without one shows the cloud
export const hasMark = (wire: Wire): boolean => wire in MARKS;

export function WireMark({
  wire,
  size = 16,
  class: cls,
}: {
  wire: Wire;
  size?: number;
  class?: string;
}) {
  const mark = MARKS[wire];
  if (mark === undefined) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.box}
      fill="currentColor"
      class={cls}
      aria-hidden="true"
    >
      <path d={mark.d} />
    </svg>
  );
}
