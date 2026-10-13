// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, spyOn, test } from "bun:test";
import type { Db } from "../../../src/server/db/index.ts";
import {
  ATTENTION_ROWS,
  MAX_ENTRY_BYTES,
} from "../../../src/shared/contracts/external-task.ts";
import { EXTERNAL_TASK_STATES } from "../../../src/shared/words.ts";
import { fixture } from "./fixture.ts";

function queries(db: Db, call: () => unknown): string[] {
  const query = spyOn(db, "query");
  try {
    call();
    return query.mock.calls.map(([sql]) => sql);
  } finally {
    query.mockRestore();
  }
}

const plan = (db: Db, sql: string, args: (string | number)[] = []) =>
  db
    .query<{ detail: string }, (string | number)[]>(`explain query plan ${sql}`)
    .all(...args)
    .map((row) => row.detail);

test("claim foreign key checks seek tasks by claim instead of scanning them", () => {
  using f = fixture();
  const detail = plan(f.db, "delete from external_task_claims where id = ?");
  expect(detail).toContain(
    "SEARCH external_tasks USING COVERING INDEX external_tasks_claim (claim_id=?)",
  );
  expect(detail.some((line) => line.startsWith("SCAN external_tasks"))).toBe(
    false,
  );
});

test("closed expiry seeks its time index without sorting or walking projects", () => {
  using f = fixture();
  const [sql] = queries(f.db, () => f.area.store.expired(f.now()));
  const detail = plan(f.db, sql!);
  expect(detail).toContain(
    "SEARCH t USING INDEX external_tasks_expired (moved_at<?)",
  );
  expect(detail.some((line) => /SCAN t\b|TEMP B-TREE/.test(line))).toBe(false);
});

test("agent pages seek each project's state indexes without scans or temp sorts", () => {
  using f = fixture();
  for (const state of EXTERNAL_TASK_STATES) f.task(state);
  for (const projectIds of [[f.projectId], [f.projectId, f.otherProjectId]]) {
    for (const states of [[], ["todo"], [...EXTERNAL_TASK_STATES]] as const) {
      for (const [after, labels] of [
        [null, []],
        [`${f.now()}.000000000000`, []],
        [null, ["build", "fix"]],
      ] as const) {
        const sqls = queries(f.db, () =>
          f.port.list({
            projectIds,
            states: [...states],
            labels: [...labels],
            held: null,
            after,
            limit: 2,
          }),
        );
        const hydrated = sqls.filter((sql) => sql.includes("last_text"));
        expect(hydrated).toHaveLength(1);
        expect(plan(f.db, hydrated[0]!)).toContain(
          "SEARCH t USING INDEX sqlite_autoindex_external_tasks_1 (id=?)",
        );
        const candidates = sqls.filter((sql) => !sql.includes("last_text"));
        expect(candidates).toHaveLength(
          projectIds.length * Math.max(states.length, 1),
        );
        for (const sql of candidates) {
          expect(f.db.query(sql).columnNames).toEqual(["moved_at", "id"]);
          const detail = plan(f.db, sql);
          expect(
            detail.some((line) =>
              /SEARCH t USING (COVERING )?INDEX external_tasks_(unfinished|closed) \(project_id=\?/.test(
                line,
              ),
            ),
          ).toBe(true);
          expect(detail.some((line) => /SCAN t\b|TEMP B-TREE/.test(line))).toBe(
            false,
          );
        }
      }
    }
  }
});

test("closed pages seek the project's closed index under a search and a state", () => {
  using f = fixture();
  f.task("done");
  f.task("canceled");
  for (const filter of [
    { q: "", state: null },
    { q: "work", state: null },
    { q: "", state: "done" },
    { q: "work", state: "canceled" },
  ] as const) {
    for (const after of [null, `${f.now()}.000000000000`]) {
      const sqls = queries(f.db, () =>
        f.area.closed(f.projectId, after, filter, 2),
      );
      const candidates = sqls.filter((sql) => !sql.includes("last_text"));
      expect(candidates).toHaveLength(1);
      const detail = plan(f.db, candidates[0]!);
      expect(
        detail.some((line) =>
          line.startsWith(
            "SEARCH t USING INDEX external_tasks_closed (project_id=?",
          ),
        ),
      ).toBe(true);
      expect(detail.some((line) => /SCAN \w+|TEMP B-TREE/.test(line))).toBe(
        false,
      );
    }
  }
});

test("held pages seek the key's open claims once and hydrate only the page", () => {
  using f = fixture();
  const held = f.task("in_progress");
  f.task("awaiting_input");
  f.task("done");
  for (const after of [null, `${f.now()}.000000000000`]) {
    const sqls = queries(f.db, () =>
      f.port.list({
        projectIds: [f.projectId, f.otherProjectId],
        states: [...EXTERNAL_TASK_STATES],
        labels: [],
        held: f.key,
        after,
        limit: 1,
      }),
    );
    const hydrated = sqls.filter((sql) => sql.includes("last_text"));
    expect(hydrated).toHaveLength(1);
    const candidates = sqls.filter((sql) => !sql.includes("last_text"));
    expect(candidates).toHaveLength(1);
    expect(f.db.query(candidates[0]!).columnNames).toEqual(["moved_at", "id"]);
    const detail = plan(f.db, candidates[0]!);
    expect(detail).toContain(
      "SEARCH c USING INDEX external_task_claims_key (key_id=?)",
    );
    expect(detail).toContain(
      "SEARCH t USING INDEX sqlite_autoindex_external_tasks_1 (id=?)",
    );
    expect(detail.some((line) => /SCAN [tc]\b/.test(line))).toBe(false);
  }
  expect(
    f.port.list({
      projectIds: [f.projectId],
      states: [],
      labels: [],
      held: { ...f.key, userId: f.member.id },
      after: null,
      limit: 1,
    }),
  ).toEqual({ rows: [], next: null });
  expect(f.area.store.byId(held.id)!.claim).not.toBeNull();
});

test("access endings seek the supplied key ids instead of scanning open claims", () => {
  using f = fixture();
  f.task("in_progress");
  const sqls = queries(f.db, () => f.area.endClaims(["unrelated"]));
  const claims = sqls.filter((sql) =>
    sql.includes("from external_task_claims"),
  );
  expect(claims).toHaveLength(1);
  expect(
    plan(f.db, claims[0]!).some((line) =>
      line.includes("USING INDEX external_task_claims_key (key_id=?)"),
    ),
  ).toBe(true);
});

test("user claim endings seek the supplied projects instead of scanning tasks", () => {
  using f = fixture();
  const [sql] = queries(f.db, () =>
    f.area.store.claimsForUser(f.owner.id, [f.projectId, f.otherProjectId]),
  );
  const detail = plan(f.db, sql!);
  expect(
    detail.some((line) =>
      line.includes(
        "SEARCH t USING INDEX external_tasks_unfinished (project_id=?",
      ),
    ),
  ).toBe(true);
  expect(detail.some((line) => /SCAN [tc]\b/.test(line))).toBe(false);
});

test("waiting rows and counts seek each Home project's unfinished index by state", () => {
  using f = fixture();
  f.task("awaiting_input");
  const sqls = queries(f.db, () =>
    f.area.waiting([f.projectId, f.otherProjectId]),
  );
  expect(sqls).toHaveLength(2);
  const rows = sqls.find((sql) => sql.includes("last_text"))!;
  expect(plan(f.db, rows)).toContain(
    "SEARCH t USING INDEX sqlite_autoindex_external_tasks_1 (id=?)",
  );
  for (const sql of sqls) {
    const args: (string | number)[] = [
      JSON.stringify([f.projectId, f.otherProjectId]),
      ...(sql === rows ? [ATTENTION_ROWS] : []),
    ];
    const detail = plan(f.db, sql, args);
    expect(
      detail.some((line) =>
        /SEARCH t USING (COVERING )?INDEX external_tasks_unfinished \(project_id=\? AND state=\?\)/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(detail.some((line) => /SCAN t\b/.test(line))).toBe(false);
  }
});

test("label counts and a task's bounds seek their indexes", () => {
  using f = fixture();
  const task = f.task("in_progress");
  f.task("done");
  const reads: [() => unknown, RegExp][] = [
    [
      () => f.area.openLabelCounts(f.projectId),
      /SEARCH t USING (COVERING )?INDEX external_tasks_unfinished \(project_id=\?/,
    ],
    [
      () => f.area.labelTasks(f.projectId),
      /SEARCH l USING COVERING INDEX external_task_labels_label \(label_id=\?\)/,
    ],
    [
      () => f.area.store.claimsSinceReopen(task.id),
      /SEARCH external_task_entries USING INDEX external_task_entries_task \(task_id=\?\)/,
    ],
    [
      () => f.area.store.counted(task.id),
      /SEARCH external_task_entries USING COVERING INDEX external_task_entries_task \(task_id=\?\)/,
    ],
  ];
  for (const [read, index] of reads) {
    for (const sql of queries(f.db, read)) {
      const detail = plan(f.db, sql);
      if (!sql.includes("external_task")) continue;
      expect(detail.some((line) => index.test(line))).toBe(true);
      expect(
        detail.some((line) => /SCAN (t|l|external_\w+)\b/.test(line)),
      ).toBe(false);
    }
  }
});

test("list queries bound the entry preview inside SQLite", () => {
  using f = fixture();
  const task = f.create("Large task");
  const claim = f.area.claim(f.key, task.id);
  const text = "q".repeat(MAX_ENTRY_BYTES);
  f.area.report(f.key, task.id, claim.claimId, "question", text, []);
  for (const read of [
    () => f.area.byProject(f.projectId),
    () =>
      f.port.list({
        projectIds: [f.projectId],
        states: ["awaiting_input"],
        labels: [],
        held: null,
        after: null,
        limit: 50,
      }),
    () => f.area.waiting([f.projectId]),
  ]) {
    const sqls = queries(f.db, read).filter((sql) => sql.includes("last_text"));
    expect(sqls).toHaveLength(1);
    const statement = f.db.query(sqls[0]!);
    expect(statement.columnNames).not.toContain("text");
    expect(statement.columnNames).not.toContain("brief_at");
    expect(statement.columnNames).not.toContain("chat_id");
    expect(sqls[0]!).toMatch(/substr\(ltrim\(e\.text,/);
  }
  const sql = queries(f.db, () => f.area.byProject(f.projectId))[0]!;
  const raw = f.db
    .query<{ last_text: string }, [string]>(sql)
    .get(f.projectId)!;
  expect(raw.last_text).toBe(text.slice(0, 600));
  expect(f.port.show(task.id, null)!.entries[0]!.text).toBe(text);
});
