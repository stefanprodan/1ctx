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
  alertOf,
  alertWords,
  authorGone,
  flagShown,
  iconOf,
  iconStatus,
  markOf,
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
  line = row.runs !== null,
  now,
}: {
  row: FeedRow;
  // whether the row stands for its automation, as its open alert does
  line?: boolean;
  // the project's name, when the page knows it; on the project page
  // the row is under the name already
  projectName: string | null;
  now: number;
}) {
  const { session } = row;
  const state = stateLine(row);
  const archived = session.archived !== null;
  const mark = markOf(row);
  const alert = alertOf(row, line);
  return (
    <a class="feed-row" href={sessionHref(session)}>
      <Icon
        name={iconOf(row)}
        class={`feed-icon ${archived ? "feed-icon-archived" : `status-${iconStatus(session)}`}`}
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
            (alert !== null || state.author !== null || state.text !== "") && (
              <>
                {state.author !== null && (
                  <span
                    class={`feed-author${authorGone(row, state) ? " feed-author-gone" : ""}`}
                  >
                    @{state.author}{" "}
                  </span>
                )}
                {alert !== null && (
                  <>
                    <span class="feed-attention">{alertWords(alert, now)}</span>
                    {alert.reason !== null && ` · ${alert.reason}`}
                  </>
                )}
                {alert === null && flagShown(session) && (
                  <>
                    <span class="feed-attention">{ATTENTION_WORDS}</span>
                    {state.text !== "" && " · "}
                  </>
                )}
                {alert === null &&
                  (session.status === "failed" ? (
                    <span class="feed-bad">{state.text}</span>
                  ) : (
                    state.text
                  ))}
              </>
            ),
          ])}
        </span>
      </span>
      <span class="feed-when">{whenText(row, now)}</span>
    </a>
  );
}
