// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Whether a transcript fold is open is kept per key for the life of the
// page, so a re-render never shuts it. Each kind of fold makes its own
// set, so a message id never opens two kinds at once.

import { signal } from "@preact/signals";
import type { TargetedEvent } from "preact";
import { useEffect, useState } from "preact/hooks";

export function folds() {
  const opened = signal<ReadonlySet<string>>(new Set());
  const set = (key: string, open: boolean) => {
    if (opened.value.has(key) === open) return;
    const next = new Set(opened.value);
    if (open) next.add(key);
    else next.delete(key);
    opened.value = next;
  };
  return {
    useFoldOpen: (key: string) => ({
      open: opened.value.has(key),
      onToggle: (event: TargetedEvent<HTMLDetailsElement>) =>
        set(key, event.currentTarget.open),
    }),
    shut: (key: string) => set(key, false),
  };
}

// a live label's clock counts this tab's time
export function useTick(active: boolean, ms = 250): void {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
}
