// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A select that keeps the picked value in a field-shaped trigger. Its
// panel may start with a search box for a long list; the highlight and
// filtering stay apart from the DOM in Select.model.ts.

import { useSignal } from "@preact/signals";
import { useEffect, useId, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import {
  clampHighlight,
  filterOptions,
  initialHighlight,
  type Option,
  stepHighlight,
} from "./Select.model.ts";
import "./select.css";

export function Select({
  label,
  value,
  options,
  onChange,
  disabled,
  search,
  mono,
  name,
  invalid,
  placeholder = "Pick one",
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
  // the box at the top of the list, for a long one
  search?: boolean;
  // the label in the mono face, for an identifier
  mono?: boolean;
  // the form's field name, so a refusal can take the focus here
  name?: string;
  // a refusal names this field
  invalid?: boolean;
  placeholder?: string;
}) {
  const open = useSignal(false);
  const query = useSignal("");
  const at = useSignal(-1);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const listId = `${id}-list`;
  const shown = open.value ? filterOptions(options, query.value) : [];
  const activeAt = clampHighlight(at.value, shown.length);
  const activeId = activeAt === -1 ? undefined : `${id}-option-${activeAt}`;
  const picked = options.find((o) => o.value === value) ?? null;

  const close = (focus: boolean) => {
    open.value = false;
    query.value = "";
    at.value = -1;
    if (focus) trigger.current?.focus();
  };
  const pick = (option: Option) => {
    if (disabled) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  useEffect(() => {
    if (!open.value) return;
    if (disabled) {
      close(false);
      return;
    }
    // The list opens on the picked option, in sight.
    at.value = initialHighlight(options, value);
    if (search) box.current?.focus();
    else list.current?.focus();
    const onPress = (ev: PointerEvent) => {
      if (!root.current?.contains(ev.target as Node)) close(false);
    };
    // Focus has already reached the next control when Tab closes the
    // panel, so removing the search box cannot break the tab order.
    const onFocus = (ev: FocusEvent) => {
      if (!root.current?.contains(ev.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("focusin", onFocus);
    };
    // The list opens once per press; a new value while open changes
    // nothing.
  }, [open.value, disabled]);

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
    if (disabled) return;
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
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close(true);
    } else if (ev.key === "Tab" && ev.shiftKey) {
      ev.preventDefault();
      close(true);
    }
  };

  return (
    <div class="select" ref={root}>
      <button
        id={`${id}-trigger`}
        ref={trigger}
        type="button"
        name={name}
        class={`select-trigger${invalid ? " select-trigger-invalid" : ""}`}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-haspopup="listbox"
        aria-controls={open.value ? listId : undefined}
        aria-expanded={open.value}
        disabled={disabled}
        onClick={() => {
          if (open.value) close(false);
          else if (!disabled) open.value = true;
        }}
        onKeyDown={(ev) => {
          if (
            !disabled &&
            !open.value &&
            (ev.key === "ArrowDown" || ev.key === "ArrowUp")
          ) {
            ev.preventDefault();
            open.value = true;
          }
        }}
      >
        <span class={`select-label${mono ? " select-mono" : ""}`}>
          {picked?.label ?? (value === "" ? placeholder : value)}
        </span>
        {picked?.detail && <span class="select-detail">{picked.detail}</span>}
        <Icon name="chevron" size={14} class="select-chevron" />
      </button>
      {open.value && (
        <div class="select-panel">
          {search && (
            <div class="select-search">
              <Icon name="search" size={14} class="select-glass" />
              <input
                ref={box}
                class="select-input"
                name="search"
                type="text"
                role="combobox"
                aria-label={`Search ${label.toLowerCase()}`}
                aria-autocomplete="list"
                aria-controls={listId}
                aria-expanded="true"
                aria-activedescendant={activeId}
                autocomplete="off"
                spellcheck={false}
                placeholder="Search"
                value={query.value}
                onInput={(ev) => {
                  const next = ev.currentTarget.value;
                  query.value = next;
                  at.value = filterOptions(options, next).length === 0 ? -1 : 0;
                }}
                onKeyDown={onKey}
              />
            </div>
          )}
          <div
            id={listId}
            ref={list}
            class="select-list"
            role="listbox"
            aria-label={label}
            aria-activedescendant={search ? undefined : activeId}
            tabIndex={search ? -1 : 0}
            onKeyDown={search ? undefined : onKey}
          >
            {shown.length === 0 ? (
              <p class="select-none" role="status">
                Nothing matches
              </p>
            ) : (
              shown.map((option, i) => (
                <div
                  id={`${id}-option-${i}`}
                  key={option.value}
                  data-index={i}
                  role="option"
                  tabIndex={-1}
                  aria-selected={option.value === value}
                  class={`select-option${i === activeAt ? " select-option-on" : ""}`}
                  // The press keeps focus in the search box.
                  onMouseDown={(ev) => ev.preventDefault()}
                  onPointerMove={() => {
                    at.value = i;
                  }}
                  onClick={() => pick(option)}
                  onKeyDown={onKey}
                >
                  <span class={`select-label${mono ? " select-mono" : ""}`}>
                    {option.label}
                  </span>
                  {option.detail && (
                    <span class="select-detail">{option.detail}</span>
                  )}
                  {option.value === value && (
                    <Icon name="check" size={14} class="select-check" />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
