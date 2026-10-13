// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The list reads of external tasks: a project's unfinished list, its
// closed pages, the agent lists, the tasks awaiting input and the label
// counts. The store builds
// on them with the single rows, the claims and the writes.

import { shapeLabelName } from "../../shared/contracts/label.ts";
import type { ExternalTaskState } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { BadRequest } from "../lib/errors.ts";
import { containing, LIKE } from "../lib/like.ts";
import { type ListInput, type RawTask, TASK_SELECT, taskRow } from "./rows.ts";
import { ATTENTION_ROWS, CLOSED_PAGE, closed, parseCursor } from "./rules.ts";

export const UNFINISHED =
  "t.state in ('todo', 'in_progress', 'awaiting_input')";
export const CLOSED = "t.state in ('done', 'canceled')";

// a task carrying any of the label names bound as JSON
const LABELED = `exists (select 1 from external_task_labels l
  join project_labels p on p.id = l.label_id
  where l.task_id = t.id and p.name in (select value from json_each(?)))`;

// a search and a state narrowing the closed pages; an empty q is none
export type ClosedFilter = {
  q: string;
  state: Extract<ExternalTaskState, "done" | "canceled"> | null;
};

const ALL_CLOSED: ClosedFilter = { q: "", state: null };

// A closed task holds no claim, so of the page's fields only the title,
// its labels and the creator's name are left to match.
function closedWhere(projectId: string, filter: ClosedFilter) {
  let where = `t.project_id = ? and ${CLOSED}`;
  const args: string[] = [projectId];
  if (filter.state !== null) {
    where += " and t.state = ?";
    args.push(filter.state);
  }
  if (filter.q !== "") {
    where += ` and (t.title ${LIKE}
      or exists (select 1 from external_task_labels l
        join project_labels p on p.id = l.label_id
        where l.task_id = t.id and p.name ${LIKE})
      or exists (select 1 from users u where u.id = t.created_by
        and u.username ${LIKE}))`;
    const pattern = containing(filter.q);
    args.push(pattern, pattern, pattern);
  }
  return { where, args };
}

export class ExternalTaskLists {
  constructor(protected readonly db: Db) {}

  byProject(projectId: string) {
    const tasks = this.db
      .query<RawTask, [string]>(
        `${TASK_SELECT} where t.project_id = ? and ${UNFINISHED}
        order by case t.state when 'awaiting_input' then 0
          when 'in_progress' then 1 else 2 end,
          t.moved_at desc, t.id`,
      )
      .all(projectId)
      .map(taskRow);
    const count = this.db
      .query<{ n: number }, [string]>(
        `select count(*) as n from external_tasks t where t.project_id = ? and ${CLOSED}`,
      )
      .get(projectId)!.n;
    return { tasks, closed: count };
  }

  private page(
    filters: { from?: string; where: string; args: (string | number)[] }[],
    after: string | null,
    limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new BadRequest("invalid page size");
    }
    const cursor = after === null ? null : parseCursor(after);
    const past =
      cursor === null
        ? ""
        : "and (t.moved_at < ? or (t.moved_at = ? and t.id > ?))";
    const values = [
      ...(cursor === null ? [] : [cursor.at, cursor.at, cursor.id]),
      limit + 1,
    ];
    const rows = filters.flatMap(({ from = "external_tasks t", where, args }) =>
      this.db
        .query<Pick<RawTask, "moved_at" | "id">, (string | number)[]>(
          `select t.moved_at, t.id from ${from}
          where ${where} ${past} order by t.moved_at desc, t.id limit ?`,
        )
        .all(...args, ...values),
    );
    rows.sort(
      (a, b) =>
        b.moved_at - a.moved_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const hydrated =
      page.length === 0
        ? []
        : this.db
            .query<RawTask, [string]>(
              `${TASK_SELECT} where t.id in (select value from json_each(?))
              order by t.moved_at desc, t.id`,
            )
            .all(JSON.stringify(page.map((row) => row.id)));
    return {
      rows: hydrated.map((raw) => ({
        ...taskRow(raw),
        answered: raw.answered === 1,
        cursor: `${raw.moved_at}.${raw.id}`,
      })),
      next: rows.length > limit && last ? `${last.moved_at}.${last.id}` : null,
    };
  }

  closed(
    projectId: string,
    after: string | null,
    limit = CLOSED_PAGE,
    filter: ClosedFilter = ALL_CLOSED,
  ) {
    const page = this.page([closedWhere(projectId, filter)], after, limit);
    return {
      tasks: page.rows.map(({ answered: _, cursor: __, ...row }) => row),
      next: page.next,
    };
  }

  list(input: ListInput) {
    if (input.held !== null) {
      return this.page(
        [
          {
            from: `external_task_claims c cross join external_tasks t
              on t.id = c.task_id and t.claim_id = c.id`,
            // a held list is the key's own, whatever labels it filters by
            where: `c.key_id = ? and c.user_id = ? and c.ended_at is null
              and t.project_id in (select value from json_each(?))`,
            args: [
              input.held.keyId,
              input.held.userId,
              JSON.stringify(input.projectIds),
            ],
          },
        ],
        input.after,
        input.limit,
      );
    }
    const states: ExternalTaskState[] = input.states.length
      ? input.states
      : ["todo"];
    const labels =
      input.labels.length === 0
        ? null
        : [...new Set(input.labels.map(shapeLabelName))];
    const filters = [...new Set(input.projectIds)].flatMap((projectId) =>
      [...new Set(states)].map((state) => ({
        where: `t.project_id = ? and t.state = ? and ${closed(state) ? CLOSED : UNFINISHED}${labels === null ? "" : ` and ${LABELED}`}`,
        args: [
          projectId,
          state,
          ...(labels === null ? [] : [JSON.stringify(labels)]),
        ],
      })),
    );
    const page = this.page(filters, input.after, input.limit);
    for (const row of page.rows) row.answered = false;
    return page;
  }

  // the tasks waiting on a member, the oldest question first
  waiting(projectIds: string[]) {
    // the unfinished clause lets the partial index serve the state
    const where = `t.project_id in (select value from json_each(?))
      and t.state = 'awaiting_input' and ${UNFINISHED}`;
    const ids = JSON.stringify(projectIds);
    const tasks = this.db
      .query<RawTask, [string, number]>(
        `${TASK_SELECT} where t.id in (
          select t.id from external_tasks t
          where ${where} order by t.moved_at, t.id limit ?
        ) order by t.moved_at, t.id`,
      )
      .all(ids, ATTENTION_ROWS)
      .map(taskRow);
    const count = this.db
      .query<{ n: number }, [string]>(
        `select count(*) as n from external_tasks t where ${where}`,
      )
      .get(ids)!.n;
    return { tasks, count };
  }

  // every label of the project in name order with how many unfinished
  // tasks carry it: one grouped count over at most MAX_UNFINISHED tasks
  openLabelCounts(projectId: string): { name: string; open: number }[] {
    const counts = new Map(
      this.db
        .query<{ label_id: string; n: number }, [string]>(
          `select l.label_id, count(*) as n from external_tasks t
          join external_task_labels l on l.task_id = t.id
          where t.project_id = ? and ${UNFINISHED}
          group by l.label_id`,
        )
        .all(projectId)
        .map((row) => [row.label_id, row.n]),
    );
    return this.db
      .query<{ id: string; name: string }, [string]>(
        "select id, name from project_labels where project_id = ? order by name",
      )
      .all(projectId)
      .map((label) => ({ name: label.name, open: counts.get(label.id) ?? 0 }));
  }

  // how many tasks carry each label of the project, closed ones too
  labelTasks(projectId: string): Map<string, number> {
    return new Map(
      this.db
        .query<{ label_id: string; n: number }, [string]>(
          `select l.label_id, count(*) as n from external_task_labels l
          where l.label_id in
            (select id from project_labels where project_id = ?)
          group by l.label_id`,
        )
        .all(projectId)
        .map((row) => [row.label_id, row.n]),
    );
  }
}
