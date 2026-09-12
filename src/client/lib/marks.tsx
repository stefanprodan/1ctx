// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The marks of the services a provider can be, drawn in the current
// colour so they sit in a tile like the icons. OpenRouter's is the
// glyph of its official logo (openrouter.ai/press), the wordmark left
// out; the box is the glyph's own bounds, squared.

import type { Wire } from "../../shared/words.ts";

const OPENROUTER =
  "M303.9475,17.19926c42.79734,0,77.48933,34.69327,77.48933,77.48933s-34.69199,77.48933-77.48933,77.48933l76.86166,76.86244c9.76367,9.76313,2.84903,26.45667-10.95697,26.45667h-220.88335c-71.32686,0-129.14889-57.82202-129.14889-129.14889S77.64197,17.19926,148.96884,17.19926h154.97866ZM148.96884,68.85881c-42.79607,0-77.48933,34.69327-77.48933,77.48933s34.69327,77.48933,77.48933,77.48933,77.48933-34.69327,77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z";

export function WireMark({
  wire,
  size = 16,
  class: cls,
}: {
  wire: Wire;
  size?: number;
  class?: string;
}) {
  if (wire !== "openrouter") return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="19.8 -34.45 361.6 361.6"
      fill="currentColor"
      class={cls}
      aria-hidden="true"
    >
      <path d={OPENROUTER} />
    </svg>
  );
}
