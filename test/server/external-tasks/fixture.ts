// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { externalTasksArea } from "../../../src/server/external-tasks/index.ts";
import { HttpError } from "../../../src/server/lib/errors.ts";
import type { TasksPort } from "../../../src/server/mcp-server/ports.ts";
import { ProjectStore } from "../../../src/server/projects/index.ts";
import { createUser, UserStore } from "../../../src/server/users/index.ts";
import type { ExternalTaskState } from "../../../src/shared/words.ts";
import { memoryDb } from "../../helpers/db.ts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function fixture() {
  const db = memoryDb();
  const projects = new ProjectStore(db);
  const users = new UserStore(db);
  const user = (username: string) =>
    createUser(
      { db, store: users, projects },
      {
        username,
        fullName: username,
        email: `${username}@example.com`,
        role: "member",
        passwordHash: "unused",
        mustChangePassword: false,
        now: 0,
      },
    );
  const owner = user("owner");
  const member = user("member");
  const projectId = projects.personal(owner.id)!.id;
  const otherProjectId = projects.personal(member.id)!.id;
  const key = { userId: owner.id, keyId: "key", keyName: "laptop" };
  const otherKey = { userId: member.id, keyId: "other-key", keyName: "other" };
  const files = new Map<string, { name: string; revision: number }>();
  const deleted = new Map<string, string>();
  let now = DAY;
  const limits = { idle: 24, days: 365 };
  const area = externalTasksArea({
    db,
    clock: () => now,
    access: {
      project: (_principal, id) => ({ id }),
      reachableProjectIds: () => [projectId],
      visibleProjectIds: () => [projectId],
    },
    externalTaskIdleHours: () => limits.idle,
    externalTaskDays: () => limits.days,
    knowledge: {
      file: (projectId, fileId) => files.get(`${projectId}/${fileId}`) ?? null,
      deletedName: (projectId, fileId) =>
        deleted.get(`${projectId}/${fileId}`) ?? null,
    },
  });
  const port: TasksPort = area;
  const create = (title = "Do the work", project = projectId) =>
    area.create(owner.id, project, {
      title,
      text: "Read the brief.",
      fileIds: [],
    }).task.task;
  const task = (state: ExternalTaskState = "open") => {
    const row = create();
    let claimId: string | null = null;
    if (state === "claimed" || state === "blocked" || state === "done") {
      claimId = area.claim(key, row.id).claimId;
    }
    if (state === "blocked")
      area.report(key, row.id, claimId!, "question", "Which path?", []);
    if (state === "done")
      area.report(key, row.id, claimId!, "result", "Finished.", []);
    if (state === "dropped") area.drop(owner.id, row.id, { state: "open" });
    return { ...area.store.byId(row.id)!, claimId };
  };
  // fills to count entries of the 250 bound, which claims do not join
  const fillEntries = (id: string, count: number) =>
    transact(db, () => {
      const have = area.store.counted(id);
      for (let i = have; i < count; i++) {
        area.store.append(id, {
          claimId: null,
          kind: "answer",
          text: `entry ${i}`,
          links: [],
          userId: owner.id,
          keyName: null,
          claimEnd: null,
          at: now,
        });
      }
      return { result: undefined };
    });
  return {
    db,
    area,
    port,
    key,
    otherKey,
    owner,
    member,
    projectId,
    otherProjectId,
    files,
    deleted,
    limits,
    create,
    task,
    fillEntries,
    now: () => now,
    at: (value: number) => {
      now = value;
    },
    advance: (ms = 1) => {
      now += ms;
    },
    [Symbol.dispose]() {
      db.close();
    },
  };
}

export function refuses(run: () => unknown, status: number, message?: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpError);
  if (!(caught instanceof HttpError))
    throw new Error("expected an HTTP refusal");
  expect(caught.status).toBe(status);
  if (message !== undefined) expect(caught.message).toBe(message);
}
