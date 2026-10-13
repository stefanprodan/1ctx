// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task as a row leading to its page, the feed's two lines:
// its state's ring, the title and its labels, then who moved it last
// (rowLine()), and when. Home's card names its project too. The state's
// ring and the labels' tags are drawn here for the task's page as well.

import type { ExternalTaskRow } from "../../../shared/contracts/external-task.ts";
import type { ExternalTaskState } from "../../../shared/words.ts";
import { ago } from "../../lib/format.ts";
import { externalTaskHref } from "../../lib/hrefs.ts";
import { RowsGo, RowsMeta, RowsTitle } from "../../ui/Rows.tsx";
import { rowLine } from "./ExternalTasks.model.ts";
import "./external-tasks.css";

// the state as one ring that fills as the work moves: empty for todo,
// half for in progress, paused for awaiting input, a check for done and
// a cross for canceled; only awaiting input takes a colour
export function TaskStateIcon({
  state,
  size = 15,
}: {
  state: ExternalTaskState;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width={1.5}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={`external-tasks-ring${
        state === "awaiting_input" ? " status-attention" : ""
      }`}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.25" />
      {state === "in_progress" && (
        <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" stroke="none" />
      )}
      {state === "awaiting_input" && <path d="M6.5 5.75v4.5M9.5 5.75v4.5" />}
      {state === "done" && <path d="m5.5 8.25 1.75 1.75 3.25-3.75" />}
      {state === "canceled" && <path d="m6 6 4 4m0-4-4 4" />}
    </svg>
  );
}

// a task's labels as tags; a tag is not a link
export function TaskTags({ labels }: { labels: readonly string[] }) {
  return labels.map((label) => (
    <span key={label} class="tag external-tasks-tag">
      {label}
    </span>
  ));
}

export function TaskRow({
  row,
  now,
  project,
}: {
  row: ExternalTaskRow;
  now: number;
  // the project's name, on a list across projects
  project?: string | null;
}) {
  const sub = [project == null ? "" : `#${project}`, rowLine(row)]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <RowsGo href={externalTaskHref(row.id)} side compact>
      <TaskStateIcon state={row.state} />
      <RowsTitle
        name={
          <span class="external-tasks-row-name">
            <span class="cut">{row.title}</span>
            <TaskTags labels={row.labels} />
          </span>
        }
        sub={sub === "" ? undefined : sub}
        prose
      />
      <RowsMeta>{ago(row.movedAt, now)}</RowsMeta>
    </RowsGo>
  );
}
