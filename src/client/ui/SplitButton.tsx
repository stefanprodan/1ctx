// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A form's one button and, split from it by a hairline, an arrow that
// opens the menu of its other actions, as wide as both (the sign-in's).
// The menu is lib/menu.ts's: a click outside or Escape closes it. An
// item runs an action, or picks one choice of several (checked). No
// items: the button alone. While something is on its way the arrow
// turns to a spinner.

import type { ComponentChildren } from "preact";
import { Icon, type IconName } from "../lib/icons.tsx";
import { useMenu } from "../lib/menu.ts";
import "./splitbutton.css";

export type SplitItem = {
  label: string;
  icon?: IconName;
  run: () => void;
  // one choice of several: true for the one picked, false for the others
  checked?: boolean;
};

function SplitMenu({
  label,
  items,
  disabled,
  working,
}: {
  label: string;
  items: readonly SplitItem[];
  disabled: boolean;
  working: boolean;
}) {
  const { open, root } = useMenu();
  const close = () => {
    open.value = false;
  };
  return (
    <span class="splitbutton-at" ref={root}>
      <button
        type="button"
        class="btn btn-primary splitbutton-pick"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open.value}
        disabled={disabled}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        {working ? (
          <span class="splitbutton-spin" aria-hidden="true" />
        ) : (
          <Icon name="chevron" size={16} />
        )}
      </button>
      {open.value && (
        <div class="menu splitbutton-menu" role="menu" aria-label={label}>
          {items.map((it) => {
            const cls = `menu-item${it.checked ? " menu-item-on" : ""}`;
            const run = () => {
              close();
              it.run();
            };
            return it.checked !== undefined ? (
              <button
                key={it.label}
                type="button"
                class={cls}
                role="menuitemradio"
                aria-checked={it.checked}
                onClick={run}
              >
                {it.icon && <Icon name={it.icon} size={14} />}
                <span class="cut">{it.label}</span>
                {it.checked && (
                  <Icon name="check" size={14} class="splitbutton-check" />
                )}
              </button>
            ) : (
              <button
                key={it.label}
                type="button"
                class={cls}
                role="menuitem"
                onClick={run}
              >
                {it.icon && <Icon name={it.icon} size={14} />}
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

export function SplitButton({
  children,
  disabled,
  onClick,
  items,
  label,
  menuDisabled = disabled,
  working = false,
  goRef,
}: {
  children: ComponentChildren;
  disabled: boolean;
  // none: the form's submit
  onClick?: () => void;
  // none: no menu
  items: readonly SplitItem[];
  // the menu's name for a screen reader, its button's title
  label: string;
  menuDisabled?: boolean;
  working?: boolean;
  goRef?: { current: HTMLButtonElement | null };
}) {
  return (
    <div class="splitbutton">
      <button
        ref={goRef}
        type={onClick === undefined ? "submit" : "button"}
        class={`btn btn-primary splitbutton-go${
          items.length > 0 ? " splitbutton-go-split" : ""
        }`}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
      {items.length > 0 && (
        <SplitMenu
          label={label}
          items={items}
          disabled={menuDisabled}
          working={working}
        />
      )}
    </div>
  );
}
