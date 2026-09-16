// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user message: who wrote it and when, then the text in a card, and
// under it Copy and Fork. The name leads to the author's page when the
// author is known.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { Message } from "../../shared/contracts/session.ts";
import { clock, initials } from "../lib/format.ts";
import { userHref } from "../lib/hrefs.ts";
import { CopyButton } from "./Copy.tsx";
import { ForkButton, type OnFork } from "./Fork.tsx";

export function UserRow({
  message: m,
  author,
  fork,
}: {
  message: Message;
  author: { name: string; username: string | null };
  // the fork action; absent where the session cannot be forked yet
  fork?: { agents: AgentSummary[]; agentId: string | null; onFork: OnFork };
}) {
  return (
    <div class="transcript-user">
      <div class="transcript-author">
        <span class="transcript-user-tile">{initials(author.name)}</span>
        {author.username === null ? (
          <span class="transcript-name">{author.name}</span>
        ) : (
          <a
            class="transcript-name transcript-name-link"
            href={userHref(author.username)}
          >
            {author.name}
          </a>
        )}
        <span class="transcript-when">{clock(m.createdAt)}</span>
      </div>
      <div class="transcript-card">{m.content}</div>
      <div class="transcript-after">
        <CopyButton text={m.content} />
        {fork !== undefined && (
          <ForkButton
            messageId={m.id}
            agents={fork.agents}
            agentId={fork.agentId}
            onFork={fork.onFork}
          />
        )}
      </div>
    </div>
  );
}
