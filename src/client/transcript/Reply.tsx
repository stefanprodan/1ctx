// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A reply: the agent's line, the reasoning fold, then the server's
// HTML plus the text received after it as a plain tail while it
// streams, so a code block in progress never breaks out of its
// element. Under a finished reply, why it was cut when it was, and
// Copy.

import type { Message } from "../../shared/contracts/session.ts";
import type { Avatar } from "../../shared/words.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { clock } from "../lib/format.ts";
import { type Live, tail } from "./stream.ts";
import { Think } from "./Think.tsx";

export type Agent = { name: string; avatar: Avatar };

// the line under a reply: why it was cut, if it was
export function cutReason(m: Message): { text: string; err: boolean } | null {
  if (m.status === "stopped") return { text: "stopped", err: false };
  if (m.status === "failed") {
    return { text: m.error ?? "failed", err: true };
  }
  if (m.finishReason === "length") {
    return { text: "cut at max tokens", err: false };
  }
  return null;
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // a page without clipboard access: the button does nothing
  }
}

export function Reply({
  message: m,
  live,
  think,
  agent,
}: {
  message: Message;
  live: Live | null;
  think: boolean;
  agent: Agent | null;
}) {
  const html = live ? live.html : m.html;
  const content = live?.content ?? m.content;
  const cut = live === null ? cutReason(m) : null;
  return (
    <div class="transcript-reply">
      <div class="transcript-author">
        <span class="transcript-agent-tile">
          <AvatarIcon name={agent?.avatar ?? "bot"} size={14} />
        </span>
        <span class="transcript-name">{agent?.name ?? "agent"}</span>
        <span class="transcript-when">{clock(m.createdAt)}</span>
      </div>
      <div class="transcript-body">
        {think && <Think message={m} live={live} />}
        {html !== "" && (
          // the server renders the markdown with raw HTML off: render/
          // is the safety boundary
          <div
            class="transcript-md"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {live !== null && (
          <div class="transcript-tail">
            {tail(live)}
            <span class="transcript-cursor" aria-hidden="true" />
          </div>
        )}
        {live === null && (
          <div class="transcript-after">
            {cut && (
              <span
                class={`transcript-cut${cut.err ? " transcript-cut-err" : ""}`}
              >
                {cut.text}
              </span>
            )}
            {content !== "" && (
              <button
                type="button"
                class="transcript-act"
                onClick={() => void copy(content)}
              >
                Copy
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
