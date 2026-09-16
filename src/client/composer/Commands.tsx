// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The command menu over the composer: the commands the draft names,
// the highlighted one lit, a blocked one greyed with its reason, an
// argument named after the word. The keyboard is the box's; a click
// picks like Tab does.

import type { Command } from "./commands.ts";

export function Commands({
  matches,
  chosen,
  block,
  onPick,
}: {
  matches: Command[];
  chosen: number;
  // why a command cannot run now, per command; null when it can
  block: (command: Command) => string | null;
  onPick: (command: Command) => void;
}) {
  return (
    <ul class="composer-cmds" aria-label="Commands">
      {matches.map((command, index) => {
        const why = block(command);
        return (
          <li key={command.name}>
            <button
              type="button"
              class={`composer-cmd${index === chosen ? " composer-cmd-on" : ""}${
                why === null ? "" : " composer-cmd-blocked"
              }`}
              // mousedown would blur the box before the click lands
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => onPick(command)}
            >
              <span class="composer-cmd-name">/{command.name}</span>
              {command.arg !== null && (
                <span class="composer-cmd-arg">{command.arg}</span>
              )}
              <span class="composer-cmd-text">{command.text}</span>
              {why !== null && <span class="composer-cmd-block">{why}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
