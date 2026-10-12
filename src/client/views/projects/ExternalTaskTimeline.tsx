// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's timeline, newest first: each entry's icon and
// kind, who wrote it (an agent through its key, a member, or 1ctx),
// when, an answer's question, its text cut to a few lines with Show
// all, and its links. Only a question still waiting for a member is
// coloured. Later pages load with Show more.

import type { ExternalTaskEntry } from "../../../shared/contracts/external-task.ts";
import { loadMoreEntries, type TaskPage } from "../../data/external-task.ts";
import { ShowMore } from "../../feed/FeedCard.tsx";
import { ago } from "../../lib/format.ts";
import { userHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useCut } from "../../lib/resize.ts";
import { Fold } from "../../ui/Fold.tsx";
import {
  RowsCard,
  RowsHandle,
  RowsLine,
  RowsNote,
  RowsTag,
} from "../../ui/Rows.tsx";
import { entryBy, GONE_USER, webLink } from "./ExternalTasks.model.ts";
import {
  ENTRY_ICONS,
  entryWords,
  type TimelineLine,
  timelineOf,
} from "./ExternalTaskTimeline.model.ts";

// a member by their handle, an agent by its user and the key as a tag,
// 1ctx and a deleted user faint
function By({ entry }: { entry: ExternalTaskEntry }) {
  if (entry.by === null && entry.keyName === null) {
    return <span class="external-tasks-by-faint">1ctx</span>;
  }
  return (
    <span class="external-tasks-by cut" title={entryBy(entry)}>
      {entry.by === null ? (
        <span class="external-tasks-by-faint">{GONE_USER}</span>
      ) : (
        <a class="external-tasks-by-link" href={userHref(entry.by.username)}>
          <RowsHandle name={entry.by.username} />
        </a>
      )}
      {entry.keyName !== null && (
        <>
          {" via "}
          <RowsTag>{entry.keyName}</RowsTag>
        </>
      )}
    </span>
  );
}

function Entry({ line, now }: { line: TimelineLine; now: number }) {
  const { entry } = line;
  const { el, open, long } = useCut<HTMLParagraphElement>([entry.text]);
  return (
    <RowsLine flush>
      <div class="external-tasks-entry">
        <p class="external-tasks-entry-head">
          <span
            class={`external-tasks-kind${line.waiting ? " status-attention" : ""}`}
          >
            <Icon
              name={ENTRY_ICONS[entry.kind]}
              size={14}
              class="external-tasks-kind-icon"
            />
            {entryWords(entry)}
          </span>
          <By entry={entry} />
          <span class="external-tasks-when">{ago(entry.at, now)}</span>
        </p>
        {line.question !== null && (
          <p class="external-tasks-entry-pair cut">
            <Icon
              name="question"
              size={12}
              class="external-tasks-entry-pair-icon"
            />
            {line.question}
          </p>
        )}
        {entry.text !== "" && (
          <Fold
            cut={long.value && !open.value}
            onOpen={() => {
              open.value = true;
            }}
            label="Show all"
            ground="card"
          >
            <p
              ref={el}
              class={`external-tasks-entry-text${open.value ? "" : " clamp"}`}
            >
              {entry.text}
            </p>
          </Fold>
        )}
        {entry.links.map((link) =>
          webLink(link) ? (
            <a
              key={link}
              class="external-tasks-link cut"
              href={link}
              target="_blank"
              rel="noopener"
            >
              {link}
            </a>
          ) : (
            <span key={link} class="external-tasks-link-text cut">
              {link}
            </span>
          ),
        )}
      </div>
    </RowsLine>
  );
}

export function Timeline({ page, now }: { page: TaskPage; now: number }) {
  return (
    <RowsCard
      label="Timeline"
      count={
        page.detail.task.entries === 0
          ? undefined
          : String(page.detail.task.entries)
      }
    >
      {page.entries.length === 0 ? (
        <RowsNote>No reports yet.</RowsNote>
      ) : (
        <>
          {timelineOf(page.entries, page.detail.task).map((line) => (
            <Entry key={line.entry.id} line={line} now={now} />
          ))}
          <ShowMore
            more={{
              next: page.next !== null,
              loading: page.more.loading,
              error: page.more.error,
            }}
            onMore={() => void loadMoreEntries()}
          />
        </>
      )}
    </RowsCard>
  );
}
