// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent's turn: its line, the work fold (the reasoning and the
// tool calls, if any), then the server's HTML
// plus the text received after it as a plain tail while it streams,
// so a code block in progress never breaks out of its element, then
// the summary fold when the window filled. A compact turn is the
// summary fold alone. Under a finished turn, why it was cut when it
// was, Copy, Fork, Regenerate on the last turn, and when it was.

import type { ComponentChildren } from "preact";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { Message } from "../../shared/contracts/session.ts";
import type { Avatar } from "../../shared/words.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { stamp } from "../lib/format.ts";
import { agentHref } from "../lib/hrefs.ts";
import { Icon } from "../lib/icons.tsx";
import { CopyButton } from "./Copy.tsx";
import { ForkButton, type OnFork } from "./Fork.tsx";
import { endedBy, type ReplyNode, type WorkNode } from "./rows.ts";
import { Summary } from "./Summary.tsx";
import { type Live, leadIn, tail } from "./stream.ts";
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

// a turn that failed before it did anything: no rows, no thinking, no
// calls and no words, so a fold would only say it worked for no time
export function emptyFailure(
  work: WorkNode,
  answer: Message | null,
  failure: string | null,
  content: string,
): boolean {
  return (
    failure !== null &&
    content === "" &&
    work.rows.length === 0 &&
    (answer?.reasoning ?? "") === "" &&
    (work.send?.toolCalls ?? 0) === 0
  );
}

export function Reply({
  node,
  live,
  agent,
  onRegenerate,
  fork,
  visuals,
}: {
  node: ReplyNode;
  live: ReadonlyMap<string, Live>;
  agent: Agent | null;
  visuals?: ComponentChildren;
  // set on the last turn alone: regenerate drops it and sends its
  // user message again
  onRegenerate?: () => void;
  // the fork action under a finished answer; absent where the session
  // cannot be forked yet
  fork?: { agents: AgentSummary[]; agentId: string | null; onFork: OnFork };
}) {
  const m = node.message;
  const running = replyRunning(node, live);
  const current = running && m !== null ? (live.get(m.id) ?? null) : null;
  const html = current?.html ?? m?.html ?? "";
  const content = current?.content ?? m?.content ?? "";
  // unslotted words that may yet be a work round's stay in the fold
  const lead = current !== null && m?.slot === null && leadIn(content);
  const ended = running ? null : endedBy(node);
  const cut = ended === null ? null : cutReason(ended);
  // a failure says so in its own block, never squeezed into the actions
  const failure = cut?.err === true ? cut.text : null;
  // the stamp is when the turn ended: the answer's end, else the last
  // row's, a stopped work round included
  const last = node.rows[node.rows.length - 1];
  const endedAt =
    m?.finishedAt ??
    node.send?.finishedAt ??
    last?.finishedAt ??
    last?.createdAt ??
    0;
  // every turn has the fold: the reasoning is always inside it, and
  // before the first token it stands for the send, so the line is
  // never bare
  const work: WorkNode = node.work ?? {
    sendId: node.sendId,
    rows: [],
    rounds: [],
    answer: m,
    send: node.send,
  };
  return (
    <div class="transcript-reply">
      <div class="transcript-author">
        <span class="avatar avatar-24 avatar-agent">
          <AvatarIcon name={agent?.avatar ?? "bot"} size={14} />
        </span>
        {agent ? (
          <a
            class="transcript-name transcript-name-link"
            href={agentHref(agent.name)}
          >
            {agent.name}
          </a>
        ) : (
          <span class="transcript-name">agent</span>
        )}
      </div>
      <div class="transcript-body">
        {!node.compact && !emptyFailure(work, m, failure, content) && (
          // once the memory phase opens the turn's own work is over
          <Work
            node={work}
            reply={m}
            live={live}
            running={running && node.send?.memoryRound == null}
          />
        )}
        {visuals}
        {html !== "" && !lead && (
          // the server renders the markdown with raw HTML off: render/
          // is the safety boundary
          <div
            class="transcript-md"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {current !== null && !lead && (
          <div class="transcript-tail">{tail(current)}</div>
        )}
        {node.summary !== null && (
          <Summary message={node.summary} live={live} />
        )}
        {node.memory !== null && (
          <Work
            node={node.memory}
            reply={null}
            live={live}
            running={running}
            memory
          />
        )}
        {!running && failure !== null && (
          <p class="notice-failed transcript-failure" role="alert">
            {failure}
          </p>
        )}
        {!running && (
          <div class="transcript-after">
            {cut && failure === null && (
              <span class="transcript-cut">{cut.text}</span>
            )}
            {content !== "" && <CopyButton text={content} />}
            {fork !== undefined &&
              m !== null &&
              m.slot === "answer" &&
              m.status !== "failed" && (
                <ForkButton
                  messageId={m.id}
                  agents={fork.agents}
                  agentId={fork.agentId}
                  onFork={fork.onFork}
                />
              )}
            {onRegenerate !== undefined && (
              <button
                type="button"
                class="transcript-act"
                title="Regenerate"
                aria-label="Regenerate"
                onClick={onRegenerate}
              >
                <Icon name="redo" size={14} />
              </button>
            )}
            <span class="transcript-sep" aria-hidden="true" />
            <span class="transcript-when">{stamp(endedAt)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
