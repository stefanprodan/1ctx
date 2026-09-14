// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One session in the stream: the chat icon in the status colour, the
// title, the project and the state line, the time. A run's line is
// under its automation's name, with the clock, in the author's place.
// The whole row is the link to the chat.

import type { StreamRow } from "../../shared/api/sessions.ts";
import { Icon } from "../lib/icons.tsx";
import { runOf, stateLine, whenText } from "./Row.model.ts";

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
  const run = runOf(row);
  const by = run !== null || line.author !== null;
  return (
    <a class="stream-row" href={`/chat/${session.id}`}>
      <Icon
        name="chat"
        class={`stream-icon stream-icon-${session.status}`}
        size={16}
      />
      <span class="stream-text">
        <span class="stream-title">{session.title}</span>
        <span class="stream-line">
          {projectName !== null && (
            <span class="stream-project">#{projectName}</span>
          )}
          {projectName !== null && (by || line.text !== "") && (
            <span class="stream-sep"> · </span>
          )}
          {run !== null ? (
            <span class="stream-run">
              <Icon name="clock" size={12} class="stream-run-icon" />
              {run}{" "}
            </span>
          ) : (
            line.author !== null && (
              <span class="stream-author">@{line.author} </span>
            )
          )}
          {line.text}
        </span>
      </span>
      <span class="stream-when">{whenText(row, now)}</span>
    </a>
  );
}
