// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The plus menu's second pane, in the menu's own box so it is placed as
// the menu is: back to the menu, then a switch per MCP server of the
// picked agent. Flipping one leaves the pane open.

import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import type { ServerRow } from "./Add.model.ts";

export function AddServers({
  rows,
  onBack,
  onFlip,
}: {
  rows: ServerRow[];
  onBack: () => void;
  onFlip: (key: string) => void;
}) {
  // the row that led here left the page with the focus on it
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus(), []);
  return (
    <>
      <button
        ref={back}
        type="button"
        role="menuitem"
        class="menu-item composer-add-item composer-add-back"
        onClick={(ev) => {
          // the row leaves the page with this click, and a click on
          // nothing would read as one outside the menu
          ev.stopPropagation();
          onBack();
        }}
      >
        <Icon name="chevron-left" size={14} class="composer-add-icon" />
        <span class="composer-add-words">
          <span>MCP servers</span>
        </span>
      </button>
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          role="switch"
          aria-checked={row.on}
          class="menu-item composer-add-item composer-add-server"
          onClick={() => onFlip(row.key)}
        >
          <Icon name="mcp" size={14} class="composer-add-icon" />
          <span class="composer-add-name cut">{row.name}</span>
          <span class="composer-add-count">{row.tools} tools</span>
          <span
            class={`composer-add-switch switch${row.on ? " switch-on" : ""}`}
          >
            <span class="switch-knob" />
          </span>
        </button>
      ))}
    </>
  );
}
