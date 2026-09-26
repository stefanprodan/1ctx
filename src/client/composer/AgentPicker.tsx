// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chip that names the agent a chat runs on, with the model in
// faint text. For a chat not started yet it opens the list of the
// project's agents; a session's agent is fixed, so the chip is static.
// The automation form picks its agent with the same chip, which asks
// for a pick in the failed colour while its agent was deleted.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { shortModel } from "../agents/meta.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { Icon } from "../lib/icons.tsx";
import { useMenu } from "../lib/menu.ts";
import { Fit } from "../ui/Fit.tsx";
import { AgentOption } from "./AgentOption.tsx";

export function AgentPicker({
  agents,
  agentId,
  onPick,
  field,
  ask,
}: {
  // null while the project's agents load
  agents: AgentSummary[] | null;
  agentId: string | null;
  // absent for a fixed agent
  onPick?: (id: string) => void;
  // drawn as a form field, full width with its list under it, where
  // the composer draws a chip with its list above
  field?: boolean;
  // the agent is not in the list and a pick is required
  ask?: boolean;
}) {
  const { open, root } = useMenu();
  const picked = agents?.find((a) => a.id === agentId) ?? null;
  const fixed = onPick === undefined;
  const asks = ask === true && picked === null;
  return (
    <div
      class={`composer-agent${field ? " composer-agent-field" : ""}`}
      ref={root}
    >
      <button
        type="button"
        class={`composer-chip${field ? " composer-chip-field" : ""}${asks ? " composer-chip-invalid" : ""}`}
        disabled={fixed || agents === null || agents.length === 0}
        aria-expanded={fixed ? undefined : open.value}
        aria-invalid={asks || undefined}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        {!asks && (
          <span
            class={`avatar ${field ? "avatar-22" : "avatar-18"} avatar-agent`}
          >
            <AvatarIcon name={picked?.avatar ?? "bot"} size={12} />
          </span>
        )}
        <span class="composer-chip-name cut">
          {asks
            ? "Pick an agent"
            : (picked?.name ?? (agents === null ? "" : "no agent"))}
        </span>
        {picked && (
          <Fit
            class="composer-chip-model cut"
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
          {(agents ?? []).map((a) => (
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
