// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat before its session lands: three turns laid out as the
// transcript lays them, each an author line over its text, then the
// foot at the composer's height. The real composer is not mounted: it
// needs the agents, the usage and its draft's scope, none known yet.
// Apart from Chat, so the route's fallback carries only the bones.

import { Bone } from "../../ui/Bones.tsx";
import { PageWaiting } from "../../ui/PageWaiting.tsx";
import "./chat-waiting.css";

// a turn's author and its lines' widths, varied so the bones read as a
// message, a reply and the next message
const TURNS: readonly { user: boolean; name: number; lines: number[] }[] = [
  { user: true, name: 14, lines: [68, 36] },
  { user: false, name: 10, lines: [94, 88, 52] },
  { user: true, name: 14, lines: [46, 24] },
];

export function ChatWaiting({ run = false }: { run?: boolean }) {
  let at = 0;
  return (
    <div
      class="chat-waiting bones-wait"
      role="status"
      aria-label={run ? "Loading the run" : "Loading the chat"}
    >
      <div class="chat-waiting-rows" aria-hidden="true">
        {TURNS.map((turn, i) => (
          <div key={i} class="chat-waiting-turn">
            <div class="chat-waiting-author">
              <Bone kind="avatar" at={at++} class="chat-waiting-avatar" />
              <Bone kind="line" at={at++} width={turn.name} />
            </div>
            <div
              class={turn.user ? "card chat-waiting-card" : "chat-waiting-text"}
            >
              {turn.lines.map((width, j) => (
                <span key={j} class="chat-waiting-line">
                  <Bone kind="line" at={at++} width={width} />
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* a run's foot is its state line, a chat's the composer */}
      <div class="chat-waiting-foot" aria-hidden="true">
        {run ? (
          <div class="chat-waiting-state">
            <Bone kind="line" at={at++} width={36} />
          </div>
        ) : (
          <div class="card chat-waiting-composer" />
        )}
      </div>
    </div>
  );
}

// the chat's page while its code loads: the head's place, then the body
export function ChatPageWaiting() {
  return (
    <PageWaiting label="Loading the chat" flush>
      <ChatWaiting />
    </PageWaiting>
  );
}

export function RunPageWaiting() {
  return (
    <PageWaiting label="Loading the run" flush>
      <ChatWaiting run />
    </PageWaiting>
  );
}
