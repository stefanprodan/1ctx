// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user message: who wrote it and when, then the text in a card.

import type { Message } from "../../shared/contracts/session.ts";
import { clock, initials } from "../lib/format.ts";

export function UserRow({
  message: m,
  author,
}: {
  message: Message;
  author: string;
}) {
  return (
    <div class="transcript-user">
      <div class="transcript-author">
        <span class="transcript-user-tile">{initials(author)}</span>
        <span class="transcript-name">{author}</span>
        <span class="transcript-when">{clock(m.createdAt)}</span>
      </div>
      <div class="transcript-card">{m.content}</div>
    </div>
  );
}
