// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { navigate } from "../app/router.ts";
import { fixedFrame, NARROW } from "../app/shell.ts";
import { Icon } from "../lib/icons.tsx";
import { visibleBottom } from "../lib/scroll.ts";
import { touch } from "../lib/touch.ts";
import { type Place, placeOf } from "./Finder.model.ts";
import { ListboxSearch, useActiveInView } from "./Listbox.tsx";
import {
  clampHighlight,
  filterOptions,
  initialHighlight,
  keyMove,
  type Option,
} from "./Select.model.ts";
import "./finder.css";

export type FinderOption = Option & {
  sub?: string;
  subBad?: boolean;
  href?: string;
};

export function Finder({
  label,
  add,
  trigger,
  triggerClass = "btn btn-small",
  title,
  disabled,
  options,
  value,
  lead,
  mono,
  placeholder,
  none,
  empty,
  align = add === undefined ? "left" : "right",
  wide,
  class: extra,
  onPick,
}: {
  // names the list and the search aloud
  label: string;
  // an Add over what an object may carry: the plus and these words
  add?: string;
  trigger?: ComponentChildren;
  triggerClass?: string;
  title?: string;
  disabled?: boolean;
  options: FinderOption[];
  value?: string;
  // shown only while nothing is typed: All providers
  lead?: FinderOption;
  mono?: boolean;
  placeholder: string;
  none: string;
  empty?: string;
  align?: "left" | "right";
  wide?: boolean;
  class?: string;
  onPick?: (value: string) => void;
}) {
  const open = useSignal(false);
  const query = useSignal("");
  const at = useSignal(-1);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const typed = query.value.trim() !== "";
  const shown = [
    ...(lead && !typed ? [lead] : []),
    ...filterOptions(options, query.value),
  ];
  const activeAt = clampHighlight(at.value, shown.length);

  const close = (focus: boolean) => {
    open.value = false;
    place.value = null;
    query.value = "";
    at.value = -1;
    if (focus) button.current?.focus();
  };
  const pick = (option: FinderOption) => {
    close(false);
    if (option.href !== undefined) navigate(option.href);
    else onPick?.(option.value);
  };

  // placed from the button's box, so a card that clips its content
  // never cuts it
  const place = useSignal<Place | null>(null);
  const measure = () => {
    const el = button.current;
    if (!el) return;
    place.value = placeOf({
      button: el.getBoundingClientRect(),
      frame: fixedFrame(el),
      view: { width: window.innerWidth, height: visibleBottom() },
      width: matchMedia(NARROW).matches ? null : wide ? 380 : 280,
      align,
    });
  };

  useEffect(() => {
    if (!open.value) return;
    measure();
    // the list opens on the picked option, so Enter keeps it
    at.value = initialHighlight(shown, value ?? "");
    const onPress = (ev: PointerEvent) => {
      if (!root.current?.contains(ev.target as Node)) close(false);
    };
    const onFocus = (ev: FocusEvent) => {
      if (!root.current?.contains(ev.target as Node)) close(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey);
    // the shell's box scrolls under a fixed panel: it follows the button
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    // a phone's keyboard resizes only the visual viewport
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.visualViewport?.removeEventListener("resize", measure);
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open.value]);

  useEffect(() => {
    if (disabled && open.value) close(false);
  }, [disabled]);

  // the search exists once the panel is placed; on touch nothing takes
  // the focus, so the keyboard stays down
  const placed = open.value && place.value !== null;
  useEffect(() => {
    if (placed && !touch()) box.current?.focus();
  }, [placed]);

  useActiveInView(list, activeAt, open.value);

  const onKey = (ev: KeyboardEvent) => {
    const move = keyMove(ev.key, activeAt, shown.length);
    if (move === null) return;
    ev.preventDefault();
    const option = shown[activeAt];
    if (move !== "pick") at.value = move;
    else if (option) pick(option);
  };

  return (
    <div class={`finder${extra ? ` ${extra}` : ""}`} ref={root}>
      <button
        ref={button}
        type="button"
        class={triggerClass}
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open.value}
        onClick={() => {
          if (open.value) close(false);
          else open.value = true;
        }}
      >
        {add === undefined ? (
          trigger
        ) : (
          <>
            <Icon name="plus" size={14} />
            {add}
          </>
        )}
      </button>
      {open.value && place.value !== null && (
        <div
          class="menu finder-panel"
          style={{
            top: `${place.value.top}px`,
            left: `${place.value.left}px`,
            width: `${place.value.width}px`,
            maxHeight: `${place.value.maxHeight}px`,
          }}
        >
          <ListboxSearch
            inputRef={box}
            name="find"
            aria-label={`Find in ${label.toLowerCase()}`}
            aria-controls={`${id}-list`}
            placeholder={placeholder}
            value={query.value}
            onInput={(ev) => {
              query.value = ev.currentTarget.value;
              at.value = 0;
            }}
            onKeyDown={onKey}
          />
          <div
            id={`${id}-list`}
            ref={list}
            class="listbox-list finder-list"
            role="menu"
            aria-label={label}
          >
            {shown.length === 0 ? (
              <p class="listbox-none" role="status">
                {typed || empty === undefined ? none : empty}
              </p>
            ) : (
              shown.map((option, i) => {
                const on = option.value === value;
                const cls = `menu-item finder-item${on ? " menu-item-on" : ""}${
                  i === activeAt ? " finder-at" : ""
                }`;
                const body = (
                  <>
                    <span class={`finder-name${mono ? " finder-mono" : ""}`}>
                      {option.label}
                    </span>
                    {option.sub !== undefined && (
                      <span
                        class={`finder-sub${option.subBad ? " error" : ""}`}
                      >
                        {option.sub}
                      </span>
                    )}
                  </>
                );
                const common = {
                  key: option.value,
                  class: cls,
                  role: "menuitem" as const,
                  "data-index": i,
                  "aria-current": on ? ("page" as const) : undefined,
                  // the press keeps the focus in the search
                  onMouseDown: (ev: MouseEvent) => ev.preventDefault(),
                  onPointerMove: () => {
                    at.value = i;
                  },
                };
                return option.href !== undefined ? (
                  <a
                    {...common}
                    href={option.href}
                    onClick={() => close(false)}
                  >
                    {body}
                  </a>
                ) : (
                  <button
                    {...common}
                    type="button"
                    onClick={() => pick(option)}
                  >
                    {body}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
