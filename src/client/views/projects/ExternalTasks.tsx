// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's External tasks tab: what the tasks are, then one card of
// the unfinished tasks in the order a member acts (blocked, claimed,
// open), searched on the page, and one of the done and dropped ones,
// searched and filtered by the server a page at a time. New external
// task leads to its page.

import type { Params } from "../../app/params.ts";
import { navigate } from "../../app/router.ts";
import {
  closedCount,
  closedFilter,
  closedMore,
  closedPages,
  externalTasks,
  externalTasksError,
  filterClosed,
  loadMoreClosed,
} from "../../data/external-tasks.ts";
import {
  type ClosedFilter,
  taskFields,
} from "../../data/external-tasks-rows.ts";
import { ShowMore } from "../../feed/FeedCard.tsx";
import { newExternalTaskHref } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { useListSearch } from "../../lib/search.ts";
import {
  RowsAdd,
  RowsCard,
  RowsFailed,
  RowsFilters,
  RowsNote,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { TaskRow } from "./ExternalTaskRow.tsx";
import { INTRO } from "./ExternalTasks.model.ts";
import { Frame } from "./Frame.tsx";
import "./external-tasks.css";

const STATES: { value: ClosedFilter["state"]; label: string }[] = [
  { value: null, label: "All" },
  { value: "done", label: "Done" },
  { value: "dropped", label: "Dropped" },
];

export function FinishedTasks({ now }: { now: number }) {
  const pages = closedPages.value;
  const more = closedMore.value;
  const filter = closedFilter.value;
  const filtered = filter.q.trim() !== "" || filter.state !== null;
  if (
    !filtered &&
    closedCount.value === 0 &&
    (pages === null || pages.rows.length === 0)
  ) {
    return null;
  }
  return (
    <RowsCard
      label="Done and dropped"
      search={
        <Search
          value={filter.q}
          onChange={(q) => void filterClosed({ ...closedFilter.value, q })}
          placeholder="Search finished tasks"
        />
      }
      action={
        <RowsFilters
          label="Show"
          filters={STATES.map((choice) => ({
            label: choice.label,
            on: filter.state === choice.value,
            onPick: () =>
              void filterClosed({
                ...closedFilter.value,
                state: choice.value,
              }),
          }))}
        />
      }
    >
      {pages === null ? (
        more.error !== null ? (
          <RowsFailed failure={more.error} />
        ) : (
          <RowsNote>Loading</RowsNote>
        )
      ) : pages.rows.length === 0 ? (
        <RowsNote>No external task matches.</RowsNote>
      ) : (
        <>
          {pages.rows.map((row) => (
            <TaskRow key={row.id} row={row} now={now} />
          ))}
          <ShowMore
            more={{
              next: pages.next !== null,
              loading: more.loading,
              error: more.error,
            }}
            onMore={() => void loadMoreClosed()}
          />
        </>
      )}
    </RowsCard>
  );
}

export function CurrentTasks({
  projectId,
  now,
}: {
  projectId: string;
  now: number;
}) {
  const list = externalTasks.value;
  const error = externalTasksError.value;
  const { q, shown, count } = useListSearch(list ?? [], taskFields);
  return (
    <RowsCard
      label="External tasks"
      search={<Search query={q} placeholder="Search current tasks" />}
      count={count}
      action={
        <RowsAdd
          label="New external task"
          onClick={() => navigate(newExternalTaskHref(projectId))}
        />
      }
    >
      {error !== null ? (
        <RowsFailed failure={error} />
      ) : list === null ? (
        <RowsNote>Loading</RowsNote>
      ) : list.length === 0 ? (
        <RowsNote>No external tasks yet.</RowsNote>
      ) : shown.length === 0 ? (
        <RowsNote>No external task matches.</RowsNote>
      ) : (
        shown.map((row) => <TaskRow key={row.id} row={row} now={now} />)
      )}
    </RowsCard>
  );
}

export function ExternalTasks({ params }: { params: Params }) {
  const id = params.id ?? "";
  const now = useNow(60_000);
  return (
    <Frame id={id} tab="external-tasks">
      {(project) => (
        <>
          <p class="external-tasks-note">{INTRO}</p>
          <CurrentTasks projectId={project.id} now={now} />
          <FinishedTasks now={now} />
        </>
      )}
    </Frame>
  );
}
