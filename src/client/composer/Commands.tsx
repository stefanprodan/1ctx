// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The command menu over the composer: the commands the draft names,
// the highlighted one lit, a blocked one greyed with its reason. The
// keyboard is the box's; a click picks like Tab does.

import type { Command, CommandName } from "./commands.ts";

export function Commands({
  matches,
  chosen,
  block,
  onPick,
}: {
  matches: Command[];
  chosen: number;
  block: string | null;
  onPick: (name: CommandName) => void;
}) {
  return (
    <ul class="composer-cmds" aria-label="Commands">
      {matches.map((command, index) => (
        <li key={command.name}>
          <button
            type="button"
            class={`composer-cmd${index === chosen ? " composer-cmd-on" : ""}${
              block === null ? "" : " composer-cmd-blocked"
            }`}
            // mousedown would blur the box before the click lands
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => onPick(command.name)}
          >
            <span class="composer-cmd-name">/{command.name}</span>
            <span class="composer-cmd-text">{command.text}</span>
            {block !== null && <span class="composer-cmd-block">{block}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
