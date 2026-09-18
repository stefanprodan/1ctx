// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user message: who wrote it and when, then the text in a card. The
// name leads to the author's page when the author is known.

import type { Message } from "../../shared/contracts/session.ts";
import { clock, initials } from "../lib/format.ts";
import { userHref } from "../lib/hrefs.ts";

export function UserRow({
  message: m,
  author,
}: {
  message: Message;
  author: { name: string; username: string | null };
}) {
  return (
    <div class="transcript-user">
      <div class="transcript-author">
        <span class="avatar avatar-24">{initials(author.name)}</span>
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
      <div class="card transcript-card">{m.content}</div>
    </div>
  );
}
