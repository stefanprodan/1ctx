// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chip that names the agent a chat runs on, with the model in
// faint text. For a chat not started yet it opens the list of the
// project's agents; a session's agent is fixed, so the chip is static.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { Icon } from "../lib/icons.tsx";

export function AgentPicker({
  agents,
  agentId,
  onPick,
}: {
  agents: AgentSummary[];
  agentId: string | null;
  // absent for a fixed agent
  onPick?: (id: string) => void;
}) {
  const open = useSignal(false);
  const root = useRef<HTMLDivElement>(null);
  const picked = agents.find((a) => a.id === agentId) ?? null;
  // a click outside or Escape closes the list
  useEffect(() => {
    if (!open.value) return;
    const onClick = (ev: MouseEvent) => {
      if (!root.current?.contains(ev.target as Node)) open.value = false;
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") open.value = false;
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open.value, open]);
  const fixed = onPick === undefined;
  return (
    <div class="composer-agent" ref={root}>
      <button
        type="button"
        class="composer-chip"
        disabled={fixed || agents.length === 0}
        aria-expanded={fixed ? undefined : open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <span class="composer-chip-tile">
          <AvatarIcon name={picked?.avatar ?? "bot"} size={12} />
        </span>
        <span class="composer-chip-name">{picked?.name ?? "no agent"}</span>
        {picked && <span class="composer-chip-model">{picked.model.id}</span>}
        {!fixed && <Icon name="chevron" size={12} />}
      </button>
      {open.value && (
        <ul class="composer-menu">
          {agents.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                class={`composer-option${a.id === agentId ? " composer-option-on" : ""}`}
                onClick={() => {
                  open.value = false;
                  onPick?.(a.id);
                }}
              >
                <span class="composer-chip-tile">
                  <AvatarIcon name={a.avatar} size={12} />
                </span>
                <span class="composer-chip-name">{a.name}</span>
                <span class="composer-chip-model">{a.model.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
