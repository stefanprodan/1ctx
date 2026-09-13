// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One session in the stream: the chat icon in the status colour, the
// title, the project and the state line, the time. The whole row is
// the link to the chat.

import type { StreamRow } from "../../shared/api/sessions.ts";
import { Icon } from "../lib/icons.tsx";
import { stateLine, whenText } from "./Row.model.ts";

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
        name="chat"
        class={`stream-icon stream-icon-${session.status}`}
        size={16}
      />
      <span class="stream-text">
        <span class="stream-title">{session.title}</span>
        <span class="stream-line">
          {projectName !== null && (
            <span class="stream-project">{projectName}</span>
          )}
          {projectName !== null && line !== "" && (
            <span class="stream-sep"> · </span>
          )}
          {line}
        </span>
      </span>
      <span class="stream-when">{whenText(row, now)}</span>
    </a>
  );
}
