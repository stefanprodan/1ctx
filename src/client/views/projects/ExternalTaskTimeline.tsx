// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task's timeline, newest first: each entry's kind, who
// wrote it (an agent through its key, a member, or 1ctx), when, its
// text cut to a few lines with Show all, and its links. Later pages
// load with Show more.

import type { ExternalTaskEntry } from "../../../shared/contracts/external-task.ts";
import { loadMoreEntries, type TaskPage } from "../../data/external-task.ts";
import { ShowMore } from "../../feed/FeedCard.tsx";
import { ago } from "../../lib/format.ts";
import { useCut } from "../../lib/resize.ts";
import { Fold } from "../../ui/Fold.tsx";
import { RowsCard, RowsLine, RowsNote } from "../../ui/Rows.tsx";
import { ENTRY_WORDS, entryBy, webLink } from "./ExternalTasks.model.ts";

const KIND_CLASS: Partial<Record<ExternalTaskEntry["kind"], string>> = {
  question: " status-attention",
  result: " status-done",
};

function Entry({ entry, now }: { entry: ExternalTaskEntry; now: number }) {
  const { el, open, long } = useCut<HTMLParagraphElement>([entry.text]);
  return (
    <RowsLine flush>
      <div class="external-tasks-entry">
        <p class="external-tasks-entry-head">
          <span class={`external-tasks-kind${KIND_CLASS[entry.kind] ?? ""}`}>
            {ENTRY_WORDS[entry.kind]}
          </span>
          <span class="cut">{entryBy(entry)}</span>
          <span class="external-tasks-when">{ago(entry.at, now)}</span>
        </p>
        {entry.text !== "" && (
          <Fold
            cut={long.value && !open.value}
            onOpen={() => {
              open.value = true;
            }}
            label="Show all"
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
          {page.entries.map((entry) => (
            <Entry key={entry.id} entry={entry} now={now} />
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
