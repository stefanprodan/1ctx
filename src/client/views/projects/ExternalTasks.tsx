// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's External tasks tab: what the tasks are, then one card of
// the unfinished tasks in the order a member acts (blocked, claimed,
// open), and the done and dropped ones folded at the foot, read a page
// at a time once unfolded. New external task leads to its page.

import type { Params } from "../../app/params.ts";
import { navigate } from "../../app/router.ts";
import {
  closedCount,
  closedMore,
  closedPages,
  externalTasks,
  externalTasksError,
  foldClosed,
  loadClosedTasks,
  loadMoreClosed,
} from "../../data/external-tasks.ts";
import { ShowMore } from "../../feed/FeedCard.tsx";
import { newExternalTaskHref } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import {
  RowsAction,
  RowsAdd,
  RowsCard,
  RowsFailed,
  RowsNote,
} from "../../ui/Rows.tsx";
import { TaskRow } from "./ExternalTaskRow.tsx";
import { INTRO } from "./ExternalTasks.model.ts";
import { Frame } from "./Frame.tsx";
import "./external-tasks.css";

function Closed({ now }: { now: number }) {
  const pages = closedPages.value;
  const more = closedMore.value;
  const count = closedCount.value;
  if (count === 0 && (pages === null || pages.rows.length === 0)) return null;
  return (
    <RowsCard
      label="Done and dropped"
      count={String(count)}
      action={
        <RowsAction
          label={pages === null ? "Show" : "Hide"}
          disabled={pages === null && more.loading}
          onClick={() =>
            pages === null ? void loadClosedTasks() : foldClosed()
          }
        />
      }
    >
      {pages === null ? (
        more.error !== null && <RowsFailed failure={more.error} />
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

export function ExternalTasks({ params }: { params: Params }) {
  const id = params.id ?? "";
  const list = externalTasks.value;
  const error = externalTasksError.value;
  const now = useNow(60_000);
  return (
    <Frame id={id} tab="external-tasks">
      {(shown) => (
        <>
          <p class="external-tasks-note">{INTRO}</p>
          <RowsCard
            label="External tasks"
            action={
              <RowsAdd
                label="New external task"
                onClick={() => navigate(newExternalTaskHref(shown.id))}
              />
            }
          >
            {error !== null ? (
              <RowsFailed failure={error} />
            ) : list === null ? (
              <RowsNote>Loading</RowsNote>
            ) : list.length === 0 ? (
              <RowsNote>No external tasks yet.</RowsNote>
            ) : (
              list.map((row) => <TaskRow key={row.id} row={row} now={now} />)
            )}
          </RowsCard>
          <Closed now={now} />
        </>
      )}
    </Frame>
  );
}
