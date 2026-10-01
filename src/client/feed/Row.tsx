// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One session in the feed: the icon in the status colour, a chat
// bubble for a chat and the clock for an automation's run, the title,
// the project and the state line, the time. A run's title is its
// automation, so its line is the agent's answer like a chat's. In All
// a run stands for its automation's runs and counts them with the
// bolt. An archived chat wears the box, quiet, and says so before its
// line, as a run that needs attention does and a run a restart started
// again. The whole row is the link to the chat.

import { type ComponentChild, Fragment } from "preact";
import type { FeedRow } from "../../shared/api/sessions.ts";
import { count } from "../lib/format.ts";
import { sessionHref } from "../lib/hrefs.ts";
import { Icon } from "../lib/icons.tsx";
import {
  ATTENTION_WORDS,
  authorGone,
  iconOf,
  markOf,
  needsAttention,
  stateLine,
  whenText,
} from "./Row.model.ts";

// the line's parts that are there, a dot between each two
function joined(parts: (ComponentChild | false)[]) {
  return parts
    .filter((part) => part !== false)
    .map((part, i) => (
      <Fragment key={i}>
        {i > 0 && <span> · </span>}
        {part}
      </Fragment>
    ));
}

export function Row({
  row,
  projectName,
  now,
}: {
  row: FeedRow;
  // the project's name, when the page knows it; on the project page
  // the row is under the name already
  projectName: string | null;
  now: number;
}) {
  const { session } = row;
  const line = stateLine(row);
  const archived = session.archived !== null;
  const mark = markOf(row);
  const attention = needsAttention(session);
  return (
    <a class="feed-row" href={sessionHref(session)}>
      <Icon
        name={iconOf(row)}
        class={`feed-icon ${archived ? "feed-icon-archived" : attention ? "status-attention" : `status-${session.status}`}`}
        size={16}
      />
      <span class="feed-text">
        <span class="feed-title cut">{session.title}</span>
        <span class="feed-line cut">
          {mark !== null && (
            <>
              <span class="feed-mark">{mark}</span>
              {" · "}
            </>
          )}
          {joined([
            projectName !== null && (
              <span class="feed-project">#{projectName}</span>
            ),
            row.runs !== null && (
              <span class="feed-runs">
                {count(row.runs)}{" "}
                <Icon name="bolt" class="feed-runs-icon" size={12} />
              </span>
            ),
            (line.author !== null || line.text !== "") && (
              <>
                {line.author !== null && (
                  <span
                    class={`feed-author${authorGone(row, line) ? " feed-author-gone" : ""}`}
                  >
                    @{line.author}{" "}
                  </span>
                )}
                {attention && (
                  <>
                    <span class="feed-attention">{ATTENTION_WORDS}</span>
                    {line.text !== "" && " · "}
                  </>
                )}
                {session.status === "failed" ? (
                  <span class="feed-bad">{line.text}</span>
                ) : (
                  line.text
                )}
              </>
            ),
          ])}
        </span>
      </span>
      <span class="feed-when">{whenText(row, now)}</span>
    </a>
  );
}
