// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A measure that changes layout inside a ResizeObserver callback resizes
// what the observer watches in the same frame, and the browser reports
// "ResizeObserver loop completed with undelivered notifications", which
// Bun's dev overlay shows as a runtime error. The next frame is outside
// the callback.

import { type Signal, useSignal } from "@preact/signals";
import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

export function onResize(node: Element, measure: () => void): () => void {
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  });
  observer.observe(node);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

// a text cut to a height or a count of lines, with Show all only while
// the cut hides something: `open` lifts the cut, `long` says it hides
// anything. The measure runs again when the node resizes or a dep moves.
export function useCut<T extends Element>(
  deps: unknown[],
): { el: RefObject<T>; open: Signal<boolean>; long: Signal<boolean> } {
  const el = useRef<T>(null);
  const open = useSignal(false);
  const long = useSignal(false);
  useLayoutEffect(() => {
    const node = el.current;
    if (node === null) return;
    const measure = () => {
      if (!open.value) long.value = node.scrollHeight > node.clientHeight + 1;
    };
    measure();
    return onResize(node, measure);
  }, [...deps, open.value]);
  return { el, open, long };
}
