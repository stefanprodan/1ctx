// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's External tasks tab: one card with a search, the switch
// Open, Done and Canceled, and New task. Open is the unfinished list,
// grouped by whose turn it is and searched on the page; Done and
// Canceled are the server's pages, searched by it, newest first. While
// the project has no task a notice says what they are, linking Connect
// agents.

import { type Signal, useSignal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect } from "preact/hooks";
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
  loadClosedTasks,
  loadMoreClosed,
} from "../../data/external-tasks.ts";
import { sameClosed, taskFields } from "../../data/external-tasks-rows.ts";
import { ShowMore } from "../../feed/FeedCard.tsx";
import { newExternalTaskHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { useListSearch } from "../../lib/search.ts";
import { PageNotice } from "../../ui/Page.tsx";
import {
  RowsAdd,
  RowsCard,
  RowsFailed,
  RowsFilters,
  RowsMore,
  RowsNote,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { CONNECT_HREF } from "../connect/Setup.model.ts";
import { TaskRow } from "./ExternalTaskRow.tsx";
import {
  GROUP_ROWS,
  type GroupState,
  groupsOf,
  INTRO,
} from "./ExternalTasks.model.ts";
import { Frame } from "./Frame.tsx";
import "./external-tasks.css";

export type TasksView = "open" | "done" | "canceled";

const VIEWS: { value: TasksView; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" },
];

export function TasksIntro() {
  return <ConnectNotice words={INTRO} />;
}

export function ConnectNotice({ words }: { words: string }) {
  return (
    <PageNotice words={words}>
      <a class="btn btn-small" href={CONNECT_HREF}>
        <Icon name="plug" size={12} />
        Connect agents
      </a>
    </PageNotice>
  );
}

// the server's pages of done or canceled tasks under the search
function ClosedRows({ now, searching }: { now: number; searching: boolean }) {
  const pages = closedPages.value;
  const more = closedMore.value;
  if (pages === null) {
    return more.error !== null ? (
      <RowsFailed failure={more.error} />
    ) : (
      <RowsNote>Loading</RowsNote>
    );
  }
  if (pages.rows.length === 0) {
    return <RowsNote>{searching ? "No task matches." : "None yet."}</RowsNote>;
  }
  return (
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
  );
}

// the unfinished tasks searched on the page, in their groups
function OpenRows({
  now,
  q,
  shown,
}: {
  now: number;
  q: string;
  shown: Parameters<typeof groupsOf>[0];
}) {
  const list = externalTasks.value;
  const error = externalTasksError.value;
  const limits = useSignal<Partial<Record<GroupState, number>>>({});
  if (error !== null) return <RowsFailed failure={error} />;
  if (list === null) return <RowsNote>Loading</RowsNote>;
  if (list.length === 0) return <RowsNote>No open tasks.</RowsNote>;
  if (q.trim() !== "" && shown.length === 0) {
    return <RowsNote>No task matches.</RowsNote>;
  }
  return groupsOf(shown, limits.value).map((group, i) => (
    <Fragment key={group.state}>
      <div
        class={`external-tasks-group${i === 0 ? " external-tasks-group-first" : ""}`}
      >
        <span class="label">{group.label}</span>
        <span class="external-tasks-group-count">{group.total}</span>
      </div>
      {group.rows.map((row) => (
        <TaskRow key={row.id} row={row} now={now} />
      ))}
      {group.more && (
        <RowsMore
          onClick={() => {
            limits.value = {
              ...limits.value,
              [group.state]: group.rows.length + GROUP_ROWS,
            };
          }}
        >
          Show more
        </RowsMore>
      )}
    </Fragment>
  ));
}

export function TasksCard({
  projectId,
  view,
  now,
}: {
  projectId: string;
  view: Signal<TasksView>;
  now: number;
}) {
  const { q, shown, count } = useListSearch(
    externalTasks.value ?? [],
    taskFields,
  );
  const closed = view.value !== "open";
  // a closed view is the server's pages under the same search
  useEffect(() => {
    if (view.value === "open") return;
    const filter = { q: q.value, state: view.value };
    if (!sameClosed(filter, closedFilter.value)) void filterClosed(filter);
    else if (closedPages.value === null) void loadClosedTasks(projectId);
  }, [q.value, view.value, projectId]);
  const searching = q.value.trim() !== "";
  return (
    <RowsCard
      label="External tasks"
      search={<Search query={q} placeholder="Search tasks" />}
      count={closed || !searching ? undefined : count}
      action={
        <>
          <RowsFilters
            label="Show"
            filters={VIEWS.map((choice) => ({
              label: choice.label,
              on: view.value === choice.value,
              onPick: () => {
                view.value = choice.value;
              },
            }))}
          />
          <RowsAdd
            label="New task"
            onClick={() => navigate(newExternalTaskHref(projectId))}
          />
        </>
      }
    >
      {closed ? (
        <ClosedRows now={now} searching={searching} />
      ) : (
        <OpenRows now={now} q={q.value} shown={shown} />
      )}
    </RowsCard>
  );
}

export function ExternalTasks({ params }: { params: Params }) {
  const id = params.id ?? "";
  const now = useNow(60_000);
  const view = useSignal<TasksView>("open");
  return (
    <Frame id={id} tab="external-tasks">
      {(project) => (
        <>
          {externalTasks.value?.length === 0 && closedCount.value === 0 && (
            <TasksIntro />
          )}
          <TasksCard projectId={project.id} view={view} now={now} />
        </>
      )}
    </Frame>
  );
}
