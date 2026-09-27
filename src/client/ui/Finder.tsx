// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A button that opens a list of names with a search pinned on top: a
// page's switcher (its own crumb step opening its siblings), a list's
// filter (`Provider: All`) and an Add over what an object may carry.
// Rows are the names in the given order, the one on screen marked, a
// row with `href` a link. With a mouse the search takes the focus; on a
// touch screen nothing does, so the keyboard stays down. Escape and a
// press outside close it, the press still doing what it does.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { navigate } from "../app/router.ts";
import { NARROW } from "../app/shell.ts";
import { Icon } from "../lib/icons.tsx";
import { touch } from "../lib/touch.ts";
import {
  clampHighlight,
  filterOptions,
  initialHighlight,
  type Option,
  stepHighlight,
} from "./Select.model.ts";
import "./finder.css";

// the screen's gutter, the page head's on a phone
const GUTTER = 16;

type Place = { top: number; left: number; width: number; maxHeight: number };

export type FinderOption = Option & {
  // a line under the name, cut at two lines
  sub?: string;
  // the line says something failed
  subBad?: boolean;
  // a link: a pick opens it
  href?: string;
};

export function Finder({
  label,
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
  align = "left",
  wide,
  class: extra,
  onPick,
}: {
  // names the list and the search aloud
  label: string;
  trigger: ComponentChildren;
  triggerClass?: string;
  // the trigger's hover: a whole name its button cuts, or why it is off
  title?: string;
  disabled?: boolean;
  options: FinderOption[];
  // the option on screen, marked
  value?: string;
  // a first option shown only while nothing is typed: All providers
  lead?: FinderOption;
  mono?: boolean;
  placeholder: string;
  // what a search that finds nothing says
  none: string;
  // what an empty list says
  empty?: string;
  // the list hangs from the trigger's left or right edge
  align?: "left" | "right";
  // 380 wide rather than 280
  wide?: boolean;
  // the owner's class on the root: its size in a row
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

  // the panel is placed on the screen from the button's box, so a card
  // that clips its content never cuts it: under the button, at its left
  // or right edge, inside the screen's gutters; a phone gives it the
  // gutters' whole width
  const place = useSignal<Place | null>(null);
  const measure = () => {
    const b = button.current?.getBoundingClientRect();
    if (!b) return;
    const room = window.innerWidth - 2 * GUTTER;
    const width = matchMedia(NARROW).matches
      ? room
      : Math.min(wide ? 380 : 280, room);
    const left = align === "right" ? b.right - width : b.left;
    const top = b.bottom + 4;
    place.value = {
      top,
      left: Math.max(
        GUTTER,
        Math.min(left, window.innerWidth - GUTTER - width),
      ),
      width,
      maxHeight: Math.max(
        160,
        Math.min(360, window.innerHeight - top - GUTTER),
      ),
    };
  };

  useEffect(() => {
    if (!open.value) return;
    measure();
    // the list opens on the picked option, so Enter keeps it
    at.value = initialHighlight(shown, value ?? "");
    const onPress = (ev: PointerEvent) => {
      if (!root.current?.contains(ev.target as Node)) close(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("keydown", onKey);
    // the shell's box scrolls under a fixed panel: it follows the button
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open.value]);

  useEffect(() => {
    if (disabled && open.value) close(false);
  }, [disabled]);

  // the search exists once the panel is placed
  const placed = open.value && place.value !== null;
  useEffect(() => {
    if (placed && !touch()) box.current?.focus();
  }, [placed]);

  useEffect(() => {
    const el =
      activeAt === -1
        ? null
        : list.current?.querySelector<HTMLElement>(
            `[data-index="${activeAt}"]`,
          );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeAt, open.value]);

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      at.value = stepHighlight(
        activeAt,
        shown.length,
        ev.key === "ArrowDown" ? 1 : -1,
      );
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const option = shown[activeAt];
      if (option) pick(option);
    }
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
        {trigger}
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
          <div class="finder-search">
            <Icon name="search" size={14} class="finder-glass" />
            <input
              ref={box}
              class="finder-input"
              type="text"
              name="find"
              role="combobox"
              aria-label={`Find in ${label.toLowerCase()}`}
              aria-controls={`${id}-list`}
              aria-expanded="true"
              autocomplete="off"
              spellcheck={false}
              placeholder={placeholder}
              value={query.value}
              onInput={(ev) => {
                query.value = ev.currentTarget.value;
                at.value = 0;
              }}
              onKeyDown={onKey}
            />
          </div>
          <div
            id={`${id}-list`}
            ref={list}
            class="finder-list"
            role="menu"
            aria-label={label}
          >
            {shown.length === 0 ? (
              <p class="finder-none" role="status">
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
