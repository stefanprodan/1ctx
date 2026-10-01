// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A message of the user's that was not sent, as a feed line: the chat
// icon in the failed colour, its first line, the chat's project and
// agent and why, and when it turned. The whole row leads to its chat.

import type { NotSentRow as Row } from "../../shared/api/sessions.ts";
import { ago } from "../lib/format.ts";
import { chatHref } from "../lib/hrefs.ts";
import { Icon } from "../lib/icons.tsx";
import { reasonShort } from "../transcript/Queued.words.ts";
import "./feed.css";

export function NotSentRow({ row, now }: { row: Row; now: number }) {
  return (
    <a class="feed-row" href={chatHref(row.sessionId)}>
      <Icon name="chat" class="feed-icon status-failed" size={16} />
      <span class="feed-text">
        <span class="feed-title cut">
          {row.line === "" ? row.title : row.line}
        </span>
        <span class="feed-line cut">
          <span class="feed-project">#{row.project}</span>
          {" · "}
          <span class="feed-author">@{row.agent}</span>
          {" · "}
          <span class="feed-bad">{reasonShort(row.reason)}</span>
        </span>
      </span>
      <span class="feed-when">{ago(row.changedAt, now)}</span>
    </a>
  );
}
