// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The search box over the stream. The query lives in the address: the
// box is seeded from it and writes it back a moment after the last
// keystroke, and the route's load does the fetch, so back, reload and
// a shared address keep the search. Escape clears it.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";

export const SEARCH_DELAY = 200;

export function Search({
  value,
  onChange,
}: {
  // the query as the address has it
  value: string;
  onChange: (q: string) => void;
}) {
  const text = useSignal(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the address moved under the box (back, a link): the box follows,
  // and a write still pending would only put the old text back
  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    text.value = value;
  }, [value, text]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const settle = (q: string, atOnce = false) => {
    if (timer.current !== null) clearTimeout(timer.current);
    if (atOnce) {
      timer.current = null;
      onChange(q);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      onChange(q);
    }, SEARCH_DELAY);
  };
  return (
    <label class="stream-search">
      <Icon name="search" size={14} />
      <input
        class="stream-search-input"
        type="search"
        name="q"
        placeholder="Search sessions"
        aria-label="Search sessions"
        autocomplete="off"
        value={text.value}
        onInput={(ev) => {
          text.value = ev.currentTarget.value;
          settle(text.value);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") {
            text.value = "";
            settle("", true);
          } else if (ev.key === "Enter") settle(text.value, true);
        }}
      />
    </label>
  );
}
