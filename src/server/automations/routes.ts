// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AutomationResponse,
  AutomationRunsResponse,
  AutomationsResponse,
  SchedulePreviewResponse,
} from "../../shared/api/automations.ts";
import type {
  MemoryResponse,
  SaveMemoryRequest,
  UndoMemoryRequest,
} from "../../shared/api/memory.ts";
import { PREVIEW_FIRES } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { Limits } from "../limits/index.ts";
import {
  MAX_MEMORY_BODY,
  type MemoryCapability,
  parseSaveMemory,
  parseUndoMemory,
} from "../memory/index.ts";
import type { SessionStore } from "../sessions/index.ts";
import type { AccessPort, AutomationActions } from "./actions.ts";
import type { Alerts } from "./alerts.ts";
import {
  MAX_AUTOMATION_BODY,
  parseDeleteAutomation,
  parsePatchAutomation,
  parseRunsQuery,
  parseSaveAutomation,
  parseSchedulePreview,
} from "./parse.ts";
import { nextFires } from "./schedule.ts";
import type { Scheduler } from "./scheduler.ts";
import type { AutomationStore } from "./store.ts";

export type RoutesDeps = {
  db: Db;
  clock: Clock;
  store: AutomationStore;
  scheduler: Scheduler;
  access: AccessPort;
  actions: AutomationActions;
  limits: { current(): Limits };
  sessions: SessionStore;
  memory: Pick<MemoryCapability, "read" | "save" | "undo">;
  // the run-attention decision is on with a decider to ask
  deciderOn(): boolean;
  alerts: Pick<Alerts, "dismiss">;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const { visible } = deps.actions;

  return [
    {
      method: "GET",
      path: "/api/projects/:id/automations",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: AutomationsResponse = {
          automations: deps.store.byProject(project.id),
          runDeadlineMs: deps.limits.current().runDeadlineMs,
          deciderOn: deps.deciderOn(),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/projects/:id/automations/preview",
      policy: "authenticated",
      handle(req, ctx) {
        deps.access.project(ctx.principal!, ctx.params.id);
        const { schedule, tz } = parseSchedulePreview(new URL(req.url));
        const body: SchedulePreviewResponse = {
          fires: nextFires(schedule, tz, deps.clock(), PREVIEW_FIRES),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/automations",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        const project = deps.access.project(principal, ctx.params.id);
        const body = parseSaveAutomation(
          await jsonBody(req, MAX_AUTOMATION_BODY),
        );
        const automation = deps.actions.create(principal, project.id, body);
        deps.scheduler.wake();
        const response: AutomationResponse = { automation };
        return json(response, 201);
      },
    },
    {
      method: "GET",
      path: "/api/automations/:id",
      policy: "authenticated",
      handle(_req, ctx) {
        const automation = visible(ctx.principal!, ctx.params.id);
        const body: AutomationResponse = { automation };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/automations/:id/memory",
      policy: "authenticated",
      handle(_req, ctx) {
        const automation = visible(ctx.principal!, ctx.params.id);
        const body: MemoryResponse = {
          memory: deps.memory.read(automation.projectId, automation.id),
        };
        return json(body);
      },
    },
    {
      method: "PUT",
      path: "/api/automations/:id/memory",
      policy: "authenticated",
      async handle(req, ctx) {
        const automation = visible(ctx.principal!, ctx.params.id);
        const request: SaveMemoryRequest = parseSaveMemory(
          await jsonBody(req, MAX_MEMORY_BODY),
        );
        const body: MemoryResponse = {
          memory: deps.memory.save(
            automation.projectId,
            automation.id,
            request,
            ctx.principal!.userId,
          ),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/automations/:id/memory/undo",
      policy: "authenticated",
      async handle(req, ctx) {
        const automation = visible(ctx.principal!, ctx.params.id);
        const request: UndoMemoryRequest = parseUndoMemory(
          await jsonBody(req, MAX_MEMORY_BODY),
        );
        const body: MemoryResponse = {
          memory: deps.memory.undo(
            automation.projectId,
            automation.id,
            request,
            ctx.principal!.userId,
          ),
        };
        return json(body);
      },
    },
    {
      method: "PATCH",
      path: "/api/automations/:id",
      policy: "authenticated",
      async handle(req, ctx) {
        const principal = ctx.principal!;
        const found = visible(principal, ctx.params.id);
        const request = parsePatchAutomation(
          await jsonBody(req, MAX_AUTOMATION_BODY),
        );
        const automation = deps.actions.update(principal, found.id, request);
        deps.scheduler.wake();
        const body: AutomationResponse = { automation };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/automations/:id/suspend",
      policy: "authenticated",
      handle(_req, ctx) {
        const automation = deps.actions.suspend(ctx.principal!, ctx.params.id);
        deps.scheduler.wake();
        return json({ automation } satisfies AutomationResponse);
      },
    },
    {
      method: "POST",
      path: "/api/automations/:id/resume",
      policy: "authenticated",
      handle(_req, ctx) {
        const automation = deps.actions.resume(ctx.principal!, ctx.params.id);
        deps.scheduler.wake();
        return json({ automation } satisfies AutomationResponse);
      },
    },
    {
      // anyone who sees it dismisses its open alert; with none open it
      // answers the automation as it is
      method: "POST",
      path: "/api/automations/:id/dismiss",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const found = visible(principal, ctx.params.id);
        const automation = transact(deps.db, () => {
          const current = visible(principal, found.id);
          const { automation, events } = deps.alerts.dismiss(current.id);
          return { result: automation, events };
        });
        return json({ automation } satisfies AutomationResponse);
      },
    },
    {
      method: "POST",
      path: "/api/automations/:id/run",
      policy: "authenticated",
      handle(_req, ctx) {
        const prepared = deps.actions.run(ctx.principal!, ctx.params.id);
        prepared.launch();
        return json(prepared.detail, 201);
      },
    },
    {
      method: "DELETE",
      path: "/api/automations/:id",
      policy: "authenticated",
      handle(req, ctx) {
        const principal = ctx.principal!;
        const { runs } = parseDeleteAutomation(new URL(req.url));
        const found = visible(principal, ctx.params.id);
        transact(deps.db, () => {
          const current = visible(principal, found.id);
          if (deps.sessions.runningAutomation(current.id)) {
            throw new Conflict("automation has a running run");
          }
          // before the row, whose delete nulls the runs' automation
          if (runs) deps.sessions.deleteRuns(current.id);
          deps.store.delete(current.id);
          // one frame for the runs, not one per run, which would have
          // each tab load its list again per run
          return {
            result: undefined,
            events: [
              {
                type: "automation.deleted" as const,
                data: {
                  projectId: current.projectId,
                  automationId: current.id,
                  runs,
                },
              },
            ],
          };
        });
        deps.scheduler.wake();
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "GET",
      path: "/api/automations/:id/runs",
      policy: "authenticated",
      handle(req, ctx) {
        const automation = visible(ctx.principal!, ctx.params.id);
        const { filter, before } = parseRunsQuery(new URL(req.url));
        const body: AutomationRunsResponse = deps.sessions.runs({
          automationId: automation.id,
          filter,
          before,
        });
        return json(body);
      },
    },
  ];
}
