// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chip that names the agent a chat runs on, with the model in
// faint text. For a chat not started yet it opens the list of the
// project's agents; a session's agent is fixed, so the chip is static.
// The automation form picks its agent with the same chip.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { shortModel } from "../agents/meta.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { Icon } from "../lib/icons.tsx";
import { Fit } from "../ui/Fit.tsx";
import { AgentOption } from "./AgentOption.tsx";
import { useMenu } from "./menu.ts";

export function AgentPicker({
  agents,
  agentId,
  onPick,
  field,
}: {
  agents: AgentSummary[];
  agentId: string | null;
  // absent for a fixed agent
  onPick?: (id: string) => void;
  // drawn as a form field, full width with its list under it, where
  // the composer draws a chip with its list above
  field?: boolean;
}) {
  const { open, root } = useMenu();
  const picked = agents.find((a) => a.id === agentId) ?? null;
  const fixed = onPick === undefined;
  return (
    <div
      class={`composer-agent${field ? " composer-agent-field" : ""}`}
      ref={root}
    >
      <button
        type="button"
        class={`composer-chip${field ? " composer-chip-field" : ""}`}
        disabled={fixed || agents.length === 0}
        aria-expanded={fixed ? undefined : open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <span
          class={`avatar ${field ? "avatar-22" : "avatar-18"} avatar-agent`}
        >
          <AvatarIcon name={picked?.avatar ?? "bot"} size={12} />
        </span>
        <span class="composer-chip-name">{picked?.name ?? "no agent"}</span>
        {picked && (
          <Fit
            class="composer-chip-model"
            long={picked.model.id}
            short={shortModel(picked.model.id)}
          />
        )}
        {!fixed && (
          <Icon
            name="chevron"
            size={field ? 14 : 12}
            class="composer-chip-chevron"
          />
        )}
      </button>
      {open.value && (
        <ul class={`menu composer-menu${field ? " composer-menu-field" : ""}`}>
          {agents.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                class={`menu-item composer-option${a.id === agentId ? " menu-item-on" : ""}`}
                onClick={() => {
                  open.value = false;
                  onPick?.(a.id);
                }}
              >
                <AgentOption agent={a} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
