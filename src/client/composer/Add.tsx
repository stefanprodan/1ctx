// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The plus at the start of the composer's row and its menu, placed as
// the agent list is. Add files opens the file picker. Web access is a
// switch, drawn as the rail's theme switch is, and flipping it leaves
// the menu open. MCP servers swaps the menu's rows for a switch per
// server, and Escape or its first row swaps them back. An item that
// cannot be used is off and says why on a line of its own.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import type { ServersItem, WebItem } from "./Add.model.ts";
import { AddServers } from "./AddServers.tsx";
import { useMenu } from "./menu.ts";

export function Add({
  readable,
  onFiles,
  web,
  onWeb,
  servers,
  onServer,
}: {
  // the picked agent can read files
  readable: boolean;
  onFiles: (files: File[]) => void;
  web: WebItem;
  onWeb: () => void;
  // null when the picked agent has no MCP server
  servers: ServersItem | null;
  onServer: (key: string) => void;
}) {
  const pane = useSignal<"menu" | "servers">("menu");
  const { open, root } = useMenu(() => {
    if (pane.value === "menu") return false;
    pane.value = "menu";
    return true;
  });
  // closed, or the agent's servers gone: the next open starts at the menu
  const paneless = !open.value || servers === null || !servers.live;
  useEffect(() => {
    if (paneless) pane.value = "menu";
  }, [paneless, pane]);
  const picker = useRef<HTMLInputElement>(null);
  // back from the servers, the focus returns to the row that led there
  const serversRow = useRef<HTMLButtonElement>(null);
  const wasServers = useRef(false);
  useEffect(() => {
    if (wasServers.current && pane.value === "menu") {
      serversRow.current?.focus();
    }
    wasServers.current = pane.value === "servers";
  }, [pane.value]);
  return (
    <div class="composer-agent" ref={root}>
      <button
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
      {open.value && pane.value === "servers" && servers !== null && (
        <div class="menu composer-menu composer-add-menu" role="menu">
          <AddServers
            rows={servers.rows}
            onBack={() => {
              pane.value = "menu";
            }}
            onFlip={onServer}
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
          <button
            type="button"
            role="switch"
            aria-checked={web.on}
            class="menu-item composer-add-item"
            disabled={!web.live}
            onClick={onWeb}
          >
            <Icon name="globe" size={14} class="composer-add-icon" />
            <span class="composer-add-words">
              <span>Web access</span>
              {web.reason !== null && (
                <span class="composer-add-block">{web.reason}</span>
              )}
            </span>
            <span
              class={`composer-add-switch switch${web.on ? " switch-on" : ""}`}
            >
              <span class="switch-knob" />
            </span>
          </button>
          {servers !== null && (
            <button
              ref={serversRow}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              class="menu-item composer-add-item"
              disabled={!servers.live}
              onClick={(ev) => {
                // the row leaves the page with this click, and a click
                // on nothing would read as one outside the menu
                ev.stopPropagation();
                pane.value = "servers";
              }}
            >
              <Icon name="mcp" size={14} class="composer-add-icon" />
              <span class="composer-add-words">
                <span>MCP servers</span>
                {servers.reason !== null && (
                  <span class="composer-add-block">{servers.reason}</span>
                )}
              </span>
              <span class="composer-add-more">
                {servers.off > 0 && <span>{servers.off} off</span>}
                <Icon name="chevron-right" size={14} />
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
