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
import { Commands } from "./Commands.tsx";
import {
  commandBlock,
  commandFill,
  commandMatches,
  commandOf,
  moveHighlight,
  runCommand,
} from "./commands.ts";
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
  onCompact,
  onRename,
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
  // /compact runs a summary round on the chat; a chat not started yet
  // has nothing to fold, so the command is refused without a call
  onCompact?: () => Promise<void>;
  // /rename <title>; a chat not started yet has no row to name
  onRename?: (title: string) => Promise<void>;
}) {
  const key = draftKey(scope);
  const text = useSignal(readDraft(key));
  const picked = useSignal<string | null>(null);
  const failure = useSignal<string | null>(null);
  // the menu's highlight, and whether Escape shut it for this draft
  const highlight = useSignal(0);
  const shut = useSignal(false);
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
  const started = onCompact !== undefined && onRename !== undefined;
  const block = commandBlock({ started, running });
  const matches = shut.value ? [] : commandMatches(text.value);
  // the highlight follows the list as it shrinks
  const chosen = Math.min(highlight.value, Math.max(0, matches.length - 1));
  const submit = async () => {
    const content = text.value.trim();
    if (content === "" || agent === null || busy) return;
    const named = commandOf(content);
    if (named === null && !ready) return;
    failure.value = null;
    const sent = text.value;
    try {
      if (named !== null) {
        await runCommand(named, block, { onCompact, onRename });
      } else await onSend(content, agent);
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
  // a chat not started yet has the page to itself, so the box shows
  // two lines at rest; in a chat the transcript needs the room
  const tall = !("sessionId" in scope);
  const placeholder =
    agents !== null && list.length === 0
      ? "No agent yet: an admin adds one first"
      : running
        ? "Replying"
        : "Send a message";
  return (
    <div class={`composer${tall ? " composer-tall" : ""}`}>
      <textarea
        ref={input}
        class="composer-text"
        name="message"
        rows={tall ? 2 : 1}
        placeholder={placeholder}
        aria-label="Message"
        disabled={agents !== null && list.length === 0}
        value={text.value}
        onInput={(ev) => {
          text.value = ev.currentTarget.value;
          failure.value = null;
          shut.value = false;
          highlight.value = 0;
          writeDraft(key, ev.currentTarget.value);
        }}
        onKeyDown={(ev) => {
          if (ev.isComposing) return;
          if (matches.length > 0) {
            const move =
              ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : 0;
            if (move !== 0) {
              ev.preventDefault();
              highlight.value = moveHighlight(chosen, matches.length, move);
              return;
            }
            if (ev.key === "Escape") {
              ev.preventDefault();
              shut.value = true;
              return;
            }
            const fill = commandFill(matches[chosen]!);
            if (
              ev.key === "Tab" ||
              (ev.key === "Enter" && text.value !== fill)
            ) {
              ev.preventDefault();
              text.value = fill;
              writeDraft(key, fill);
              return;
            }
          }
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void submit();
          }
        }}
      />
      {matches.length > 0 && (
        <Commands
          matches={matches}
          chosen={chosen}
          block={block}
          onPick={(command) => {
            text.value = commandFill(command);
            writeDraft(key, text.value);
            input.current?.focus();
          }}
        />
      )}
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
