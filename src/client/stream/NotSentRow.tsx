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
import "./stream.css";

export function NotSentRow({ row, now }: { row: Row; now: number }) {
  return (
    <a class="stream-row" href={chatHref(row.sessionId)}>
      <Icon name="chat" class="stream-icon status-failed" size={16} />
      <span class="stream-text">
        <span class="stream-title cut">
          {row.line === "" ? row.title : row.line}
        </span>
        <span class="stream-line cut">
          <span class="stream-project">#{row.project}</span>
          {" · "}
          <span class="stream-author">@{row.agent}</span>
          {" · "}
          <span class="stream-bad">{reasonShort(row.reason)}</span>
        </span>
      </span>
      <span class="stream-when">{ago(row.changedAt, now)}</span>
    </a>
  );
}
