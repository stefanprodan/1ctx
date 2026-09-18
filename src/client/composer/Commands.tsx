// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The command menu over the composer: the commands the draft names,
// the highlighted one lit (the keys or the pointer move it), a blocked one greyed with its reason, an
// argument named after the word. The keyboard is the box's; a click
// picks like Tab does.

import type { Command } from "./commands.ts";

export function Commands({
  matches,
  chosen,
  block,
  onPick,
  onHover,
}: {
  matches: Command[];
  chosen: number;
  // why a command cannot run now, per command; null when it can
  block: (command: Command) => string | null;
  onPick: (command: Command) => void;
  // the pointer moves the highlight, so one row is lit at a time
  onHover: (index: number) => void;
}) {
  return (
    <ul class="menu composer-cmds" aria-label="Commands">
      {matches.map((command, index) => {
        const why = block(command);
        return (
          <li key={command.name}>
            <button
              type="button"
              class={`menu-item composer-cmd${index === chosen ? " menu-item-on" : ""}${
                why === null ? "" : " composer-cmd-blocked"
              }`}
              // mousedown would blur the box before the click lands
              onMouseDown={(ev) => ev.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(command)}
            >
              <span class="composer-cmd-name">/{command.name}</span>
              {command.arg !== null && (
                <span class="composer-cmd-arg">{command.arg}</span>
              )}
              <span class="composer-cmd-text cut">{command.text}</span>
              {why !== null && <span class="composer-cmd-block">{why}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
