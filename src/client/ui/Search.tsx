// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import "./search.css";

const SEARCH_DELAY = 200;

// A box swapped for another over the same query in one render (a list's
// waiting card for its landed one, both bound to the signal held above
// the wait) hands over its focus, caret and any text still waiting to be
// written, so typing goes on through the swap. Matched on the signal,
// never the words: two pages' boxes say the same (Search sessions), and
// a route change must not move text into the next page's. A box bound
// by value hands nothing over. Dropped once that render is done, so no
// later box takes it.
type Handoff = {
  query: Signal<string>;
  text: string;
  start: number;
  end: number;
};
let handoff: Handoff | null = null;

export function Search(
  props: { placeholder: string } & (
    | { query: Signal<string> }
    | { value: string; onChange: (q: string) => void }
  ),
) {
  const { placeholder } = props;
  const query = "query" in props ? props.query : null;
  const value = "query" in props ? props.query.value : props.value;
  const onChange =
    "query" in props
      ? (q: string) => {
          props.query.value = q;
        }
      : props.onChange;
  const text = useSignal(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLInputElement>(null);
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
  useLayoutEffect(() => {
    const el = box.current;
    const held = handoff;
    if (el !== null && held !== null && held.query === query) {
      handoff = null;
      el.focus();
      el.setSelectionRange(held.start, held.end);
      if (held.text !== text.value) {
        text.value = held.text;
        onChange(held.text);
      }
    }
    return () => {
      if (el === null || query === null || document.activeElement !== el) {
        return;
      }
      handoff = {
        query,
        text: text.value,
        start: el.selectionStart ?? 0,
        end: el.selectionEnd ?? 0,
      };
      queueMicrotask(() => {
        handoff = null;
      });
    };
  }, []);
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
      <Icon name="search" size={14} class="search-icon" />
      <input
        ref={box}
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
          } else if (ev.key === "Enter") {
            // inside a form, Enter would submit it
            ev.preventDefault();
            settle(text.value, true);
          }
        }}
      />
    </label>
  );
}
