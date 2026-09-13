// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent's turn: its line, the work fold when the send called
// tools, the reasoning fold for a plain reply, then the server's HTML
// plus the text received after it as a plain tail while it streams,
// so a code block in progress never breaks out of its element. Under
// a finished turn, why it was cut when it was, and Copy.

import type { Message } from "../../shared/contracts/session.ts";
import type { Avatar } from "../../shared/words.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { clock } from "../lib/format.ts";
import { endedBy, type ReplyNode, type WorkNode } from "./rows.ts";
import { type Live, tail } from "./stream.ts";
import { Think } from "./Think.tsx";
import { Work } from "./Work.tsx";

export type Agent = { name: string; avatar: Avatar };

export function replyRunning(
  node: ReplyNode,
  live: ReadonlyMap<string, Live>,
): boolean {
  // the durable summary wins over buffers left from the preceding
  // render; without a summary, a live row is the reconnect evidence
  if (node.send !== null) return node.send.status === "running";
  return node.rows.some((row) => live.has(row.id));
}

// the line under a turn: why it was cut, if it was. A cap that ended
// the loop is the fold's word, not this line's
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
  node,
  live,
  agent,
}: {
  node: ReplyNode;
  live: ReadonlyMap<string, Live>;
  agent: Agent | null;
}) {
  const m = node.message;
  const running = replyRunning(node, live);
  const current = running && m !== null ? (live.get(m.id) ?? null) : null;
  const html = current?.html ?? m?.html ?? "";
  const content = current?.content ?? m?.content ?? "";
  const ended = running ? null : endedBy(node);
  const cut = ended === null ? null : cutReason(ended);
  const at =
    m?.createdAt ?? node.rows[0]?.createdAt ?? node.send?.startedAt ?? 0;
  // before the first token the fold stands for the send, so the line
  // is never bare; the text may still turn out to be a step, and then
  // the server's slot moves the row into the fold
  const work: WorkNode | null =
    node.work ??
    (running && content === ""
      ? {
          sendId: node.sendId,
          rows: [],
          rounds: [],
          answer: null,
          send: node.send,
        }
      : null);
  const think =
    work === null &&
    m !== null &&
    ((current?.reasoning ?? "") !== "" || m.reasoning !== "");
  return (
    <div class="transcript-reply">
      <div class="transcript-author">
        <span class="transcript-agent-tile">
          <AvatarIcon name={agent?.avatar ?? "bot"} size={14} />
        </span>
        <span class="transcript-name">{agent?.name ?? "agent"}</span>
        <span class="transcript-when">{clock(at)}</span>
      </div>
      <div class="transcript-body">
        {work !== null && (
          <Work node={work} reply={m} live={live} running={running} />
        )}
        {think && m !== null && <Think message={m} live={current} />}
        {html !== "" && (
          // the server renders the markdown with raw HTML off: render/
          // is the safety boundary
          <div
            class="transcript-md"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {current !== null && (
          <div class="transcript-tail">
            {tail(current)}
            <span class="transcript-cursor" aria-hidden="true" />
          </div>
        )}
        {!running && (
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
