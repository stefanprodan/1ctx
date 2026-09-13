// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A text with a shorter form for when the long one does not fit its
// line: the browser measures, and the span shows the short form the
// moment the long one overflows, again on every resize. A model id
// drops its org this way; what still overflows is cut with an ellipsis
// by the caller's class.

import { useSignal } from "@preact/signals";
import { useLayoutEffect, useRef } from "preact/hooks";

export function Fit({
  long,
  short,
  class: cls,
}: {
  long: string;
  short: string;
  class: string;
}) {
  const el = useRef<HTMLSpanElement>(null);
  const shrunk = useSignal(false);
  useLayoutEffect(() => {
    const span = el.current;
    if (!span || long === short) return;
    const measure = () => {
      // measure the long form in a probe so the shown form never
      // decides its own fate
      const probe = document.createElement("span");
      probe.className = span.className;
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.whiteSpace = "nowrap";
      probe.style.width = "auto";
      probe.textContent = long;
      span.parentElement?.appendChild(probe);
      const wide = probe.offsetWidth > span.clientWidth;
      probe.remove();
      shrunk.value = wide;
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(span);
    return () => watch.disconnect();
  }, [long, short, shrunk]);
  return (
    <span class={cls} ref={el} title={shrunk.value ? long : undefined}>
      {shrunk.value ? short : long}
    </span>
  );
}
