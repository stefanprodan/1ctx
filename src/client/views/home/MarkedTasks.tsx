// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's External tasks card, between Not sent and the feed, only while
// a task in one of the user's projects needs a member: a row per marked
// task, latest mark first, naming its project and leading to its page,
// which clears the mark.

import { markedTasks } from "../../data/marked-tasks.ts";
import { projects } from "../../data/projects.ts";
import { RowsCard } from "../../ui/Rows.tsx";
import { TaskRow } from "../projects/ExternalTaskRow.tsx";

export function MarkedTasks({ now }: { now: number }) {
  const marked = markedTasks.value;
  if (marked === null || marked.tasks.length === 0) return null;
  const name = (id: string) =>
    projects.value?.find((p) => p.id === id)?.name ?? null;
  return (
    <RowsCard label="External tasks" count={String(marked.count)}>
      {marked.tasks.map((row) => (
        <TaskRow
          key={row.id}
          row={row}
          now={now}
          project={name(row.projectId)}
        />
      ))}
    </RowsCard>
  );
}
