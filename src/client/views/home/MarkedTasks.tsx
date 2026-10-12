// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's External tasks card, between Not sent and the feed, only while
// a task in one of the user's projects needs a member: a row per marked
// task, latest mark first, naming its project and leading to its page,
// which clears the mark. It opens on a few rows and grows on Show more
// within what the read holds, so many marks never push the feed away.

import { useState } from "preact/hooks";
import { markedTasks } from "../../data/marked-tasks.ts";
import { projects } from "../../data/projects.ts";
import { ShowMore } from "../../feed/FeedCard.tsx";
import { RowsCard } from "../../ui/Rows.tsx";
import { TaskRow } from "../projects/ExternalTaskRow.tsx";

export const FIRST_ROWS = 5;
export const MORE_ROWS = 20;

export function MarkedTasks({ now }: { now: number }) {
  const [shown, setShown] = useState(FIRST_ROWS);
  const marked = markedTasks.value;
  if (marked === null || marked.tasks.length === 0) return null;
  const name = (id: string) =>
    projects.value?.find((p) => p.id === id)?.name ?? null;
  return (
    <RowsCard label="External tasks" count={String(marked.count)}>
      {marked.tasks.slice(0, shown).map((row) => (
        <TaskRow
          key={row.id}
          row={row}
          now={now}
          project={name(row.projectId)}
        />
      ))}
      <ShowMore
        more={{
          next: marked.tasks.length > shown,
          loading: false,
          error: null,
        }}
        onMore={() => setShown((n) => n + MORE_ROWS)}
      />
    </RowsCard>
  );
}
