// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

// A streamed block turned into markdown is often shorter than its plain
// tail was; at the transcript's end that shrink pulls the text down and
// the next tokens push it up. While it streams the element keeps the
// tallest height it reached at its current width: a new width rewraps
// the text, so the hold starts again from what it measures then.
export function useHeldHeight(
  ref: RefObject<HTMLElement | null>,
  streaming: boolean,
): void {
  const width = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!streaming) {
      el.style.minHeight = "";
      width.current = 0;
      return;
    }
    if (el.offsetWidth !== width.current) {
      el.style.minHeight = "";
      width.current = el.offsetWidth;
    }
    el.style.minHeight = `${el.offsetHeight}px`;
  });
}
