// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  ClosedTasksResponse,
  ExternalTasksResponse,
  WaitingTasksResponse,
} from "../../shared/api/external-tasks.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody, parseNoQuery } from "../lib/body.ts";
import { NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { taskActions } from "./actions.ts";
import type { ClosedFilter } from "./lists.ts";
import {
  MAX_MOVE_BODY,
  parseCreateTask,
  parseMoveTask,
  parsePatchTask,
  parseProjectTasks,
  parseTaskDetail,
  parseTaskWaiting,
} from "./parse.ts";
import { forPage, type TaskRead } from "./show.ts";

export type AccessPort = {
  project(principal: Principal, id: string): { id: string };
  reachableProjectIds(principal: Principal): string[];
  // a chat's user, by id: null when disabled or gone
  visibleProjectIds(userId: string): string[] | null;
};

type RoutesDeps = {
  db: Db;
  access: AccessPort;
  homeProjectIds(principal: Principal): string[];
  tasks: ReturnType<typeof taskActions> & {
    projectOf(id: string): string | null;
    show(
      id: string,
      before: string | null,
      viewer: Principal | null,
    ): TaskRead | null;
    byProject(projectId: string): ExternalTasksResponse;
    closed(
      projectId: string,
      after: string | null,
      filter: ClosedFilter,
    ): ClosedTasksResponse;
    waiting(projectIds: string[]): Omit<WaitingTasksResponse, "projectIds">;
  };
};

export function routes({
  db,
  access,
  homeProjectIds,
  tasks,
}: RoutesDeps): RouteDescriptor[] {
  const visible = (principal: Principal, id: string) => {
    const projectId = tasks.projectOf(id);
    if (projectId === null) throw new NotFound("no such external task");
    try {
      access.project(principal, projectId);
    } catch (err) {
      if (err instanceof NotFound) throw new NotFound("no such external task");
      throw err;
    }
    return id;
  };
  // a write answers the task as its page reads it
  function write(
    principal: Principal,
    id: string,
    act: () => TaskRead,
  ): Response {
    return json(
      forPage(
        transact(db, () => {
          visible(principal, id);
          return { result: act() };
        }),
      ),
    );
  }

  return [
    {
      method: "GET",
      path: "/api/projects/:id/external-tasks",
      policy: "authenticated",
      handle(req, ctx) {
        const project = access.project(ctx.principal!, ctx.params.id);
        const { closed, after, filter } = parseProjectTasks(new URL(req.url));
        return json(
          closed
            ? tasks.closed(project.id, after, filter)
            : tasks.byProject(project.id),
        );
      },
    },
    {
      method: "GET",
      path: "/api/external-tasks",
      policy: "authenticated",
      handle(req, ctx) {
        parseTaskWaiting(new URL(req.url));
        const projectIds = homeProjectIds(ctx.principal!);
        const body: WaitingTasksResponse = {
          ...tasks.waiting(projectIds),
          projectIds,
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/external-tasks/:id",
      policy: "authenticated",
      handle(req, ctx) {
        const id = visible(ctx.principal!, ctx.params.id);
        return json(
          forPage(
            tasks.show(id, parseTaskDetail(new URL(req.url)), ctx.principal!)!,
          ),
        );
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/external-tasks",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        const project = access.project(principal, ctx.params.id);
        parseNoQuery(new URL(req.url));
        const body = parseCreateTask(await jsonBody(req));
        const result = transact(db, () => {
          access.project(principal, project.id);
          return { result: tasks.create(principal.userId, project.id, body) };
        });
        return json(forPage(result), 201);
      },
    },
    {
      method: "PATCH",
      path: "/api/external-tasks/:id",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        const id = visible(principal, ctx.params.id);
        parseNoQuery(new URL(req.url));
        const body = parsePatchTask(await jsonBody(req));
        return write(principal, id, () =>
          tasks.edit(principal.userId, id, body, principal),
        );
      },
    },
    ...(["answer", "unclaim", "cancel", "reopen"] as const).map(
      (move): RouteDescriptor => ({
        method: "POST",
        path: `/api/external-tasks/:id/${move}`,
        policy: "authenticated",
        async handle(req, ctx) {
          const principal = ctx.principal!;
          const id = visible(principal, ctx.params.id);
          parseNoQuery(new URL(req.url));
          const body = parseMoveTask(await jsonBody(req, MAX_MOVE_BODY), move);
          return write(principal, id, () =>
            tasks[move](principal.userId, id, body, principal),
          );
        },
      }),
    ),
    {
      method: "DELETE",
      path: "/api/external-tasks/:id",
      policy: "authenticated",
      handle(req, ctx) {
        const principal = ctx.principal!;
        const id = visible(principal, ctx.params.id);
        parseNoQuery(new URL(req.url));
        transact(db, () => {
          visible(principal, id);
          return { result: tasks.delete(id) };
        });
        return new Response(null, { status: 204 });
      },
    },
  ];
}
