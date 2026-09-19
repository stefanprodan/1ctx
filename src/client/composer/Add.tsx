// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The plus at the start of the composer's row and its menu, placed as
// the agent list is. One item for now, Add files, which opens the file
// picker. An agent whose model takes no tools cannot read a file, so
// the item is off and says why on a line of its own.

import { useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import { useMenu } from "./menu.ts";

export function Add({
  readable,
  onFiles,
}: {
  // the picked agent can read files
  readable: boolean;
  onFiles: (files: File[]) => void;
}) {
  const { open, root } = useMenu();
  const picker = useRef<HTMLInputElement>(null);
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
      {open.value && (
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
        </div>
      )}
    </div>
  );
}
