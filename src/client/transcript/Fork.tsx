// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Fork button under a turn: it opens the list of the project's
// agents, the session's own first and marked, and picking one makes a
// new chat from the rows up to this turn on that agent. Every fork
// button waits while one is on its way; a refusal is the menu's one
// line until it opens again. The list hangs under the button when it
// fits above the transcript's foot, else it rises over the button, so
// it never covers the composer.

import { useSignal } from "@preact/signals";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { AgentOption } from "../composer/AgentOption.tsx";
import { useMenu } from "../composer/menu.ts";
import { forking } from "../data/fork.ts";
import { says } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { forkChoices, opensUp } from "./Fork.model.ts";

export type OnFork = (messageId: string, agentId: string) => Promise<void>;

export function ForkButton({
  messageId,
  agents,
  agentId,
  onFork,
}: {
  messageId: string;
  agents: AgentSummary[];
  // the session's agent, listed first
  agentId: string | null;
  onFork: OnFork;
}) {
  const { open, root } = useMenu();
  const failure = useSignal<string | null>(null);
  const up = useSignal(false);
  const busy = forking.value;
  const choices = forkChoices(agents, agentId);
  // the room under the button ends where the foot begins
  const toggle = () => {
    failure.value = null;
    if (!open.value && root.current) {
      const foot = document.querySelector(".transcript-foot");
      const limit = foot?.getBoundingClientRect().top ?? window.innerHeight;
      up.value = opensUp(
        root.current.getBoundingClientRect().bottom,
        limit,
        choices.length,
      );
    }
    open.value = !open.value;
  };
  const pick = async (id: string) => {
    failure.value = null;
    try {
      await onFork(messageId, id);
      open.value = false;
    } catch (err) {
      failure.value = says(err);
    }
  };
  return (
    <div class="transcript-fork" ref={root}>
      <button
        type="button"
        class="transcript-act"
        title="Fork"
        aria-label="Fork"
        aria-expanded={open.value}
        disabled={busy}
        onClick={toggle}
      >
        <Icon name="fork" size={14} />
      </button>
      {open.value && (
        <ul
          class={`menu transcript-fork-menu${up.value ? " transcript-fork-menu-up" : ""}`}
        >
          {failure.value !== null && (
            <li class="transcript-fork-failure">{failure.value}</li>
          )}
          {agents.length === 0 && (
            <li class="transcript-fork-none">No agents</li>
          )}
          {choices.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                class={`menu-item transcript-fork-option${a.id === agentId ? " menu-item-on" : ""}`}
                disabled={busy}
                onClick={() => void pick(a.id)}
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
