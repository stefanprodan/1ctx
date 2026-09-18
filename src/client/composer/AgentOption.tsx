// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent as a list of agents draws it: the avatar in its tile, the
// name, and the model in faint text, short when the long id does not
// fit. The composer's chip list and the transcript's Fork list both
// draw this, inside the item the list gives it.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { shortModel } from "../agents/meta.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { Fit } from "../ui/Fit.tsx";
import "./composer.css";

export function AgentOption({ agent }: { agent: AgentSummary }) {
  return (
    <>
      <span class="avatar avatar-18 avatar-agent">
        <AvatarIcon name={agent.avatar} size={12} />
      </span>
      <span class="composer-option-name cut">{agent.name}</span>
      <Fit
        class="composer-option-model cut"
        long={agent.model.id}
        short={shortModel(agent.model.id)}
      />
    </>
  );
}
