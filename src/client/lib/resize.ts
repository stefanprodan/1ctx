// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A measure that changes layout inside a ResizeObserver callback resizes
// what the observer watches in the same frame, and the browser reports
// "ResizeObserver loop completed with undelivered notifications", which
// Bun's dev overlay shows as a runtime error. The next frame is outside
// the callback.

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
