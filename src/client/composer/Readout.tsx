// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Readout } from "./context.ts";

// the context readout next to Send: the words over a thin meter
export function ContextReadout({ context }: { context: Readout }) {
  return (
    <span class="composer-ctx" title={context.title}>
      <span>{context.text}</span>
      <span class="meter composer-ctx-meter">
        <span class="meter-fill" style={{ width: `${context.percent}%` }} />
      </span>
    </span>
  );
}
