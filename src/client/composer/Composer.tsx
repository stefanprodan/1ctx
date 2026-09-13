// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The card the user writes in: the text that grows with it, the agent
// chip, the context readout, and Send, which is Stop while the reply
// runs. Enter sends, Shift+Enter breaks a line. Two modes: a chat, where the message goes
// into it, and a project, where it starts one. The draft survives a
// navigation; a refusal shows under the box until the next keystroke.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { RoundUsage } from "../../shared/contracts/session.ts";
import { Icon } from "../lib/icons.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { readout } from "./context.ts";
import { draftKey, readDraft, writeDraft } from "./draft.ts";
import "./composer.css";

export const MAX_HEIGHT = 160;

export type Scope = { sessionId: string } | { projectId: string };

export function Composer({
  scope,
  agents,
  agentId,
  running,
  busy,
  usage,
  onSend,
  onStop,
}: {
  scope: Scope;
  agents: AgentSummary[] | null;
  // the session's agent; null for a chat not started yet
  agentId: string | null;
  // a reply is streaming: Send is Stop
  running: boolean;
  // a send is on its way to the server
  busy: boolean;
  // the session's last counted round, for the context readout; none
  // for a chat not started yet
  usage?: RoundUsage | null;
  onSend: (text: string, agentId: string) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const key = draftKey(scope);
  const text = useSignal(readDraft(key));
  const picked = useSignal<string | null>(null);
  const failure = useSignal<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = agents ?? [];
  const fixed = agentId !== null;
  const agent = fixed
    ? agentId
    : (picked.value ?? (list.length > 0 ? list[0].id : null));

  const grow = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight)}px`;
  };
  // the scope changed: the draft of the new one, and the cursor in the box
  useEffect(() => {
    text.value = readDraft(key);
    failure.value = null;
    input.current?.focus();
  }, [key, text, failure]);
  useEffect(grow, [text.value]);

  const ready = agent !== null && !busy && !running;
  const submit = async () => {
    const content = text.value.trim();
    if (content === "" || agent === null || !ready) return;
    failure.value = null;
    const sent = text.value;
    try {
      await onSend(content, agent);
      // what was typed while the send was on its way stays
      if (text.value === sent) {
        text.value = "";
        writeDraft(key, "");
      }
    } catch (err) {
      failure.value = err instanceof Error ? err.message : String(err);
    }
  };
  const context = readout(usage);
  const placeholder =
    agents !== null && list.length === 0
      ? "No agent yet: an admin adds one first"
      : running
        ? "Replying"
        : "Send a message";
  return (
    <div class="composer">
      <textarea
        ref={input}
        class="composer-text"
        name="message"
        rows={1}
        placeholder={placeholder}
        aria-label="Message"
        disabled={agents !== null && list.length === 0}
        value={text.value}
        onInput={(ev) => {
          text.value = ev.currentTarget.value;
          failure.value = null;
          writeDraft(key, ev.currentTarget.value);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
            ev.preventDefault();
            void submit();
          }
        }}
      />
      {failure.value && <p class="composer-failure error">{failure.value}</p>}
      <div class="composer-row">
        <AgentPicker
          agents={list}
          agentId={agent}
          onPick={
            fixed
              ? undefined
              : (id) => {
                  picked.value = id;
                }
          }
        />
        {context && (
          <span class="composer-ctx" title={context.title}>
            <span class="composer-ctx-n">{context.text}</span>
            <span class="composer-ctx-track">
              <span
                class="composer-ctx-fill"
                style={{ width: `${context.percent}%` }}
              />
            </span>
          </span>
        )}
        <button
          type="button"
          class={`composer-send${running ? " composer-stop" : ""}`}
          aria-label={running ? "Stop" : "Send"}
          disabled={running ? false : !ready || text.value.trim() === ""}
          onClick={() => {
            if (running) {
              onStop().catch((err) => {
                failure.value =
                  err instanceof Error ? err.message : String(err);
              });
            } else void submit();
          }}
        >
          <Icon name={running ? "stop" : "send"} size={16} />
        </button>
      </div>
    </div>
  );
}
