// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The search box in a card's head band: the glass, then the text, no
// box of its own. The owner holds the query: the stream keeps it in the
// address, where the route's load does the fetch, so back, reload and a
// shared address keep the search; a list already loaded filters in
// place. The box writes the query a moment after the last keystroke,
// and Escape clears it.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import "./search.css";

const SEARCH_DELAY = 200;

export function Search({
  value,
  onChange,
  placeholder,
}: {
  // the query as its owner holds it
  value: string;
  onChange: (q: string) => void;
  placeholder: string;
}) {
  const text = useSignal(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the query moved under the box (back, a link): the box follows,
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
    <label class="search">
      <Icon name="search" size={14} />
      <input
        class="search-input"
        type="search"
        name="q"
        placeholder={placeholder}
        aria-label={placeholder}
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
