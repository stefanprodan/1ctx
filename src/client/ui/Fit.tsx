// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A text with a shorter form for when the long one does not fit its
// line: the browser measures, and the span shows the short form the
// moment the long one overflows, again on every resize. A model id
// drops its org this way; what still overflows is cut with an ellipsis
// by the caller's class. The caller's class bounds the span, by the
// line it is in or by a max-width; the probe carries the class in the
// same place, so it is bounded the same way and the measure never
// depends on which form the span shows.

import { useSignal } from "@preact/signals";
import { useLayoutEffect, useRef } from "preact/hooks";
import { onResize } from "../lib/resize.ts";

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
      // a probe next to the span, under the same class in the same
      // layout, holds the long form: it overflows or it does not,
      // whatever the span shows at the moment
      const probe = document.createElement("span");
      probe.className = span.className;
      probe.style.visibility = "hidden";
      probe.textContent = long;
      span.after(probe);
      const wide = probe.scrollWidth > probe.clientWidth;
      probe.remove();
      shrunk.value = wide;
    };
    measure();
    return onResize(span, measure);
  }, [long, short, shrunk]);
  return (
    <span class={cls} ref={el} title={shrunk.value ? long : undefined}>
      {shrunk.value ? short : long}
    </span>
  );
}
