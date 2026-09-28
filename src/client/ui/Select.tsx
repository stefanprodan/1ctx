// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useEffect, useId, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import { touch } from "../lib/touch.ts";
import { ListboxSearch, useActiveInView } from "./Listbox.tsx";
import {
  clampHighlight,
  filterOptions,
  initialHighlight,
  keyMove,
  type Option,
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
  search?: boolean;
  mono?: boolean;
  // so a refusal can take the focus here
  name?: string;
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
    at.value = initialHighlight(options, value);
    if (search && !touch()) box.current?.focus();
    else list.current?.focus();
    const onPress = (ev: PointerEvent) => {
      if (!root.current?.contains(ev.target as Node)) close(false);
    };
    // focus has already reached the next control when Tab closes the
    // panel, so removing the search box cannot break the tab order
    const onFocus = (ev: FocusEvent) => {
      if (!root.current?.contains(ev.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("focusin", onFocus);
    };
    // a new value while open changes nothing
  }, [open.value, disabled]);

  useActiveInView(list, activeAt, open.value);

  const onKey = (ev: KeyboardEvent) => {
    if (disabled) return;
    const move = keyMove(ev.key, activeAt, shown.length);
    if (move !== null) {
      ev.preventDefault();
      const option = shown[activeAt];
      if (move !== "pick") at.value = move;
      else if (option) pick(option);
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
        <span class={`select-label cut${mono ? " select-mono" : ""}`}>
          {picked?.label ?? (value === "" ? placeholder : value)}
        </span>
        {picked?.detail && (
          <span class="select-detail cut">{picked.detail}</span>
        )}
        <Icon name="chevron" size={14} class="select-chevron" />
      </button>
      {open.value && (
        <div class="menu select-panel">
          {search && (
            <ListboxSearch
              inputRef={box}
              name="search"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={activeId}
              placeholder="Search"
              value={query.value}
              onInput={(ev) => {
                query.value = ev.currentTarget.value;
                at.value = 0;
              }}
              onKeyDown={onKey}
            />
          )}
          <div
            id={listId}
            ref={list}
            class="listbox-list select-list"
            role="listbox"
            aria-label={label}
            aria-activedescendant={search ? undefined : activeId}
            tabIndex={search ? -1 : 0}
            onKeyDown={search ? undefined : onKey}
          >
            {shown.length === 0 ? (
              <p class="listbox-none" role="status">
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
                  // the press keeps focus in the search box
                  onMouseDown={(ev) => ev.preventDefault()}
                  onPointerMove={() => {
                    at.value = i;
                  }}
                  onClick={() => pick(option)}
                  onKeyDown={onKey}
                >
                  <span class={`select-label cut${mono ? " select-mono" : ""}`}>
                    {option.label}
                  </span>
                  {option.detail && (
                    <span class="select-detail cut">{option.detail}</span>
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
