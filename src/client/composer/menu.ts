// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A composer chip's list: open on a click, closed by a click outside
// it or by Escape.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";

export function useMenu() {
  const open = useSignal(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open.value) return;
    const onClick = (ev: MouseEvent) => {
      if (!root.current?.contains(ev.target as Node)) open.value = false;
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") open.value = false;
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open.value, open]);
  return { open, root };
}
