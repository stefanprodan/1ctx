// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The marks of the services a provider can be, drawn in the current
// colour so they sit in a tile like the icons. Each is the provider's
// logo from models.dev (models.dev/logos/<id>.svg) in its own box. The
// OpenAI wires speak for many servers, so they keep the cloud.

import type { Wire } from "../../shared/words.ts";

const OPENROUTER_PATH =
  "M728.039 234C819.325 234 893.323 308.62 893.323 400.668C893.323 492.716 819.325 567.336 728.039 567.336L891.984 732.656C912.81 753.655 898.061 789.56 868.613 789.56H397.472C245.333 789.56 122 665.193 122 511.78C122 358.367 245.333 234 397.472 234H728.039ZM397.472 345.112C306.189 345.112 232.189 419.732 232.189 511.78C232.189 603.828 306.189 678.448 397.472 678.448C488.756 678.448 562.756 603.828 562.756 511.78C562.756 419.732 488.756 345.112 397.472 345.112Z";

const GOOGLE_PATH =
  "M37 20.034C27.8809 20.5837 20.5808 27.8809 20.0326 37H19.966C19.4163 27.8809 12.1177 20.5837 3 20.034V19.9674C12.1191 19.4163 19.4163 12.1191 19.966 3H20.0326C20.5822 12.1191 27.8809 19.4163 37 19.9674V20.034Z";

const OPENCODE_GO_PATH =
  "M19.4004 21H5V3H19.4004V6.59961H8.59961V17.4004H15.7998V13.7998H12.2002V10.2002H19.4004V21Z";

const AZURE_PATH =
  "M21.68 7.58398L11.296 29.68L4 29.6L12.144 15.584L21.68 7.58398ZM22.8 9.32798L36 32.416H11.584L26.464 29.76L18.672 20.496L22.8 9.32798Z";

const MARKS: Partial<Record<Wire, { d: string; box: string }>> = {
  openrouter: { d: OPENROUTER_PATH, box: "0 0 1024 1024" },
  gemini: { d: GOOGLE_PATH, box: "0 0 40 40" },
  opencode: { d: OPENCODE_GO_PATH, box: "0 0 24 24" },
  azure: { d: AZURE_PATH, box: "0 0 40 40" },
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
