// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The @ menu over the composer, the command menu's box and keys: the
// agents the draft names, each with its avatar, its @name and its
// model, the highlighted one lit. A click picks like Tab does.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { shortModel } from "../agents/meta.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { Fit } from "../ui/Fit.tsx";

export function Summons({
  matches,
  chosen,
  onPick,
  onHover,
}: {
  matches: AgentSummary[];
  chosen: number;
  onPick: (agent: AgentSummary) => void;
  // the pointer moves the highlight, so one row is lit at a time
  onHover: (index: number) => void;
}) {
  return (
    <ul class="menu composer-cmds" aria-label="Agents">
      {matches.map((agent, index) => (
        <li key={agent.id}>
          <button
            type="button"
            class={`menu-item composer-cmd${index === chosen ? " menu-item-on" : ""}`}
            // mousedown would blur the box before the click lands
            onMouseDown={(ev) => ev.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(agent)}
          >
            <span class="avatar avatar-18 avatar-agent">
              <AvatarIcon name={agent.avatar} size={12} />
            </span>
            <span class="composer-cmd-name">@{agent.name}</span>
            <Fit
              class="composer-cmd-model cut"
              long={agent.model.id}
              short={shortModel(agent.model.id)}
            />
          </button>
        </li>
      ))}
    </ul>
  );
}
