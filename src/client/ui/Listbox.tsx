// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { InputHTMLAttributes, Ref, RefObject } from "preact";
import { useEffect } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import "./listbox.css";

export function ListboxSearch({
  inputRef,
  ...input
}: {
  inputRef: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return (
    <div class="listbox-search">
      <Icon name="search" size={14} class="listbox-glass" />
      <input
        ref={inputRef}
        class="listbox-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        autocomplete="off"
        spellcheck={false}
        {...input}
      />
    </div>
  );
}

export function useActiveInView(
  list: RefObject<HTMLElement | null>,
  activeAt: number,
  open: boolean,
): void {
  useEffect(() => {
    if (activeAt === -1) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${activeAt}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeAt, open]);
}
