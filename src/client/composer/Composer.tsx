// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The card the user writes in: the text that grows with it, the agent
// chip, and Send, which is Stop while the reply runs. Enter sends,
// Shift+Enter breaks a line. Two modes: a chat, where the message goes
// into it, and a project, where it starts one. The draft survives a
// navigation; a refusal shows under the box until the next keystroke.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { Icon } from "../lib/icons.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
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
    try {
      await onSend(content, agent);
      text.value = "";
      writeDraft(key, "");
    } catch (err) {
      failure.value = err instanceof Error ? err.message : String(err);
    }
  };
  const placeholder =
    agents !== null && list.length === 0
      ? "No agent yet: an admin adds one first"
      : running
        ? "Replying"
        : "Message";
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
        <span class="composer-hint">Enter to send, Shift+Enter for a line</span>
        <button
          type="button"
          class={`composer-send${running ? " composer-stop" : ""}`}
          aria-label={running ? "Stop" : "Send"}
          disabled={running ? false : !ready || text.value.trim() === ""}
          onClick={() => {
            if (running) void onStop();
            else void submit();
          }}
        >
          <Icon name={running ? "stop" : "send"} size={16} />
        </button>
      </div>
    </div>
  );
}
