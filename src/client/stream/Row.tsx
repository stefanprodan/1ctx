// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One session in the stream: the icon in the status colour, a chat
// bubble for a chat and the clock for an automation's run, the title,
// the project and the state line, the time. A run's title is its
// automation, so its line is the agent's answer like a chat's. The
// whole row is the link to the chat.

import type { StreamRow } from "../../shared/api/sessions.ts";
import { Icon } from "../lib/icons.tsx";
import { iconOf, stateLine, whenText } from "./Row.model.ts";

export function Row({
  row,
  projectName,
  now,
}: {
  row: StreamRow;
  // the project's name, when the page knows it; on the project page
  // the row is under the name already
  projectName: string | null;
  now: number;
}) {
  const { session } = row;
  const line = stateLine(row);
  return (
    <a class="stream-row" href={`/chat/${session.id}`}>
      <Icon
        name={iconOf(row)}
        class={`stream-icon ${
          session.status === "stopped"
            ? "stream-icon-stopped"
            : `status-${session.status}`
        }`}
        size={16}
      />
      <span class="stream-text">
        <span class="stream-title cut">{session.title}</span>
        <span class="stream-line cut">
          {projectName !== null && (
            <span class="stream-project">#{projectName}</span>
          )}
          {projectName !== null &&
            (line.author !== null || line.text !== "") && <span> · </span>}
          {line.author !== null && (
            <span class="stream-author">@{line.author} </span>
          )}
          {session.status === "failed" ? (
            <span class="stream-bad">{line.text}</span>
          ) : (
            line.text
          )}
        </span>
      </span>
      <span class="stream-when">{whenText(row, now)}</span>
    </a>
  );
}
