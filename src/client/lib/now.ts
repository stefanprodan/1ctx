// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The clock a view's "2m ago" words read, moved every ms; null holds it
// still, for a view whose words stop moving.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

export function useNow(ms: number | null): number {
  const now = useSignal(Date.now());
  useEffect(() => {
    if (ms === null) return;
    const timer = setInterval(() => {
      now.value = Date.now();
    }, ms);
    return () => clearInterval(timer);
  }, [ms, now]);
  return now.value;
}
