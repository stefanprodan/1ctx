// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The plus at the start of the composer's row and its menu, placed as
// the agent list is. Add files opens the file picker. Web access and
// Visuals are switches, drawn as the rail's theme switch is, and
// flipping one leaves the menu open. MCP servers and Skills each swap
// the menu's rows for a switch per server or skill, and Escape or the
// pane's first row swaps them back. An item that cannot be used is off and says why on a line
// of its own.

import { useSignal } from "@preact/signals";
import type { Ref } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon, type IconName } from "../lib/icons.tsx";
import { type PaneItem, panelessOf, type WebItem } from "./Add.model.ts";
import { AddPane } from "./AddPane.tsx";
import { useMenu } from "./menu.ts";

type Pane = "servers" | "skills";
const PANES: Record<Pane, { title: string; icon: IconName }> = {
  servers: { title: "MCP servers", icon: "mcp" },
  skills: { title: "Skills", icon: "skill" },
};

// the menu's row that is a switch for a kind alone
function SwitchItem({
  name,
  icon,
  item,
  onFlip,
}: {
  name: string;
  icon: IconName;
  item: WebItem;
  onFlip: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={item.on}
      class="menu-item composer-add-item"
      disabled={!item.live}
      onClick={onFlip}
    >
      <Icon name={icon} size={14} class="composer-add-icon" />
      <span class="composer-add-words">
        <span>{name}</span>
        {item.reason !== null && (
          <span class="composer-add-block">{item.reason}</span>
        )}
      </span>
      <span class={`composer-add-switch switch${item.on ? " switch-on" : ""}`}>
        <span class="switch-knob" />
      </span>
    </button>
  );
}

// the menu's row that leads to a pane
function PaneLink({
  pane,
  item,
  row,
  onOpen,
}: {
  pane: Pane;
  item: PaneItem;
  row: Ref<HTMLButtonElement>;
  onOpen: () => void;
}) {
  return (
    <button
      ref={row}
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      class="menu-item composer-add-item"
      disabled={!item.live}
      onClick={(ev) => {
        // the row leaves the page with this click, and a click on
        // nothing would read as one outside the menu
        ev.stopPropagation();
        onOpen();
      }}
    >
      <Icon name={PANES[pane].icon} size={14} class="composer-add-icon" />
      <span class="composer-add-words">
        <span>{PANES[pane].title}</span>
        {item.reason !== null && (
          <span class="composer-add-block">{item.reason}</span>
        )}
      </span>
      <span class="composer-add-more">
        {item.off > 0 && <span>{item.off} off</span>}
        <Icon name="chevron-right" size={14} />
      </span>
    </button>
  );
}

export function Add({
  readable,
  onFiles,
  web,
  onWeb,
  visuals,
  onVisuals,
  servers,
  skills,
  onFlip,
}: {
  // the picked agent can read files
  readable: boolean;
  onFiles: (files: File[]) => void;
  web: WebItem;
  onWeb: () => void;
  visuals: WebItem;
  onVisuals: () => void;
  // null when the picked agent has no MCP server
  servers: PaneItem | null;
  // null when the picked agent has no skill
  skills: PaneItem | null;
  // a server's or a skill's switch, by its key
  onFlip: (key: string) => void;
}) {
  const pane = useSignal<"menu" | Pane>("menu");
  const { open, root } = useMenu(() => {
    if (pane.value === "menu") return false;
    pane.value = "menu";
    return true;
  });
  const items = { servers, skills };
  const shown = pane.value === "menu" ? null : items[pane.value];
  const paneless = panelessOf(open.value, pane.value, shown);
  useEffect(() => {
    if (paneless) pane.value = "menu";
  }, [paneless, pane]);
  const picker = useRef<HTMLInputElement>(null);
  // back from a pane, the focus returns to the row that led there
  const rows = {
    servers: useRef<HTMLButtonElement>(null),
    skills: useRef<HTMLButtonElement>(null),
  };
  const plus = useRef<HTMLButtonElement>(null);
  const was = useRef<"menu" | Pane>("menu");
  useEffect(() => {
    if (was.current !== "menu" && pane.value === "menu") {
      // the row is gone or off when what it listed went away under the pane
      const row = rows[was.current].current;
      (row === null || row.disabled ? plus.current : row)?.focus();
    }
    was.current = pane.value;
  }, [pane.value, rows.servers, rows.skills]);
  return (
    <div class="composer-agent" ref={root}>
      <button
        ref={plus}
        type="button"
        class={`btn-icon composer-add${open.value ? " composer-add-on" : ""}`}
        aria-label="Add"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <Icon name="plus" size={14} />
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(ev) => {
          const files = [...(ev.currentTarget.files ?? [])];
          // the same file picked twice in a row still fires a change
          ev.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      {open.value && pane.value !== "menu" && shown !== null && (
        <div class="menu composer-menu composer-add-menu" role="menu">
          <AddPane
            title={PANES[pane.value].title}
            icon={PANES[pane.value].icon}
            rows={shown.rows}
            onBack={() => {
              pane.value = "menu";
            }}
            onFlip={onFlip}
          />
        </div>
      )}
      {open.value && pane.value === "menu" && (
        <div class="menu composer-menu composer-add-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            class="menu-item composer-add-item"
            disabled={!readable}
            onClick={() => {
              open.value = false;
              picker.current?.click();
            }}
          >
            <Icon name="clip" size={14} class="composer-add-icon" />
            <span class="composer-add-words">
              <span>Add files</span>
              {!readable && (
                <span class="composer-add-block">Agent cannot read files</span>
              )}
            </span>
          </button>
          <SwitchItem
            name="Web access"
            icon="globe"
            item={web}
            onFlip={onWeb}
          />
          <SwitchItem
            name="Visuals"
            icon="visual"
            item={visuals}
            onFlip={onVisuals}
          />
          {(["servers", "skills"] as const).map((name) => {
            const item = items[name];
            return item === null ? null : (
              <PaneLink
                key={name}
                pane={name}
                item={item}
                row={rows[name]}
                onOpen={() => {
                  pane.value = name;
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
