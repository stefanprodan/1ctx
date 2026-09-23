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
import type { AutomationSummary } from "../../shared/contracts/automation.ts";
import { PREVIEW_FIRES } from "../../shared/words.ts";
import type { AgentRow } from "../agents/index.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, Forbidden, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { Limits } from "../limits/index.ts";
import {
  MAX_MEMORY_BODY,
  type MemoryCapability,
  parseSaveMemory,
  parseUndoMemory,
} from "../memory/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { SessionStore } from "../sessions/index.ts";
import type { UserRow } from "../users/index.ts";
import {
  MAX_AUTOMATION_BODY,
  parseDeleteAutomation,
  parsePatchAutomation,
  parseRunsQuery,
  parseSaveAutomation,
  parseSchedulePreview,
} from "./parse.ts";
import { checkSchedule, nextFire, nextFires } from "./schedule.ts";
import type { Scheduler } from "./scheduler.ts";
import {
  type AutomationFields,
  type AutomationStore,
  MAX_AUTOMATIONS_PER_PROJECT,
} from "./store.ts";

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
};

export type RoutesDeps = {
  db: Db;
  clock: Clock;
  store: AutomationStore;
  scheduler: Scheduler;
  access: AccessPort;
  agents: { byId(id: string): AgentRow | null };
  users: { byId(id: string): UserRow | null };
  limits: { current(): Limits };
  sessions: SessionStore;
  memory: Pick<MemoryCapability, "read" | "save" | "undo">;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const changed = (automation: AutomationSummary) => ({
    type: "automation.changed" as const,
    data: { projectId: automation.projectId, automation },
  });
  const visible = (principal: Principal, id: string) => {
    const row = deps.store.byId(id);
    if (row === null) throw new NotFound("no such automation");
    deps.access.project(principal, row.projectId);
    return row;
  };
  const editable = (principal: Principal, row: AutomationSummary) => {
    if (row.ownerId !== principal.userId && principal.role !== "admin") {
      throw new Forbidden("only the owner or an admin edits an automation");
    }
  };
  const agent = (id: string): AgentRow => {
    const row = deps.agents.byId(id);
    if (row === null) throw new BadRequest("no such agent");
    return row;
  };
  const deadline = (value: number | null) => {
    if (value !== null && value > deps.limits.current().runDeadlineMs) {
      throw new BadRequest("deadline is above the run limit");
    }
  };

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
        agent(body.agentId);
        deadline(body.deadlineMs);
        if (body.ownMemory && body.projectMemory) {
          throw new BadRequest("ownMemory and projectMemory cannot both be on");
        }
        const now = deps.clock();
        const nextAt = checkSchedule(body.schedule, body.tz, now);
        const automation = transact(deps.db, () => {
          deps.access.project(principal, project.id);
          agent(body.agentId);
          deadline(body.deadlineMs);
          if (deps.store.count(project.id) >= MAX_AUTOMATIONS_PER_PROJECT) {
            throw new Conflict("project has too many automations");
          }
          if (deps.store.nameTaken(project.id, body.name)) {
            throw new Conflict("name is taken");
          }
          const fields: AutomationFields = {
            ...body,
            projectId: project.id,
            ownerId: principal.userId,
          };
          const created = deps.store.create({ ...fields, nextAt, now });
          return { result: created, events: [changed(created)] };
        });
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
        editable(principal, found);
        const patch = parsePatchAutomation(
          await jsonBody(req, MAX_AUTOMATION_BODY),
        );
        const automation = transact(deps.db, () => {
          const current = visible(principal, found.id);
          editable(principal, current);
          const next = { ...current, ...patch };
          if (next.ownMemory && next.projectMemory) {
            throw new BadRequest(
              "ownMemory and projectMemory cannot both be on",
            );
          }
          agent(next.agentId);
          deadline(next.deadlineMs);
          if (deps.store.nameTaken(current.projectId, next.name, current.id)) {
            throw new Conflict("name is taken");
          }
          const now = deps.clock();
          checkSchedule(next.schedule, next.tz, now);
          // a new schedule or zone ends a wait; other fields leave it
          const scheduleChanged =
            next.schedule !== current.schedule || next.tz !== current.tz;
          const nextAt =
            current.suspendedAt !== null
              ? null
              : scheduleChanged
                ? nextFire(next.schedule, next.tz, now)
                : current.nextAt;
          const updated = deps.store.update(current.id, {
            agentId: next.agentId,
            name: next.name,
            instructions: next.instructions,
            schedule: next.schedule,
            tz: next.tz,
            deadlineMs: next.deadlineMs,
            retentionDays: next.retentionDays,
            nextAt,
            projectMemory: next.projectMemory,
            ownMemory: next.ownMemory,
            memoryGuidance: next.memoryGuidance,
            disabledCapabilities: next.disabledCapabilities,
            now,
          })!;
          return { result: updated, events: [changed(updated)] };
        });
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
        const principal = ctx.principal!;
        const found = visible(principal, ctx.params.id);
        const automation = transact(deps.db, () => {
          const current = visible(principal, found.id);
          if (current.suspendedAt !== null) return { result: current };
          const updated = deps.store.suspend(
            current.id,
            principal.userId,
            deps.clock(),
          )!;
          return { result: updated, events: [changed(updated)] };
        });
        deps.scheduler.wake();
        return json({ automation } satisfies AutomationResponse);
      },
    },
    {
      method: "POST",
      path: "/api/automations/:id/resume",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const found = visible(principal, ctx.params.id);
        const automation = transact(deps.db, () => {
          const current = visible(principal, found.id);
          if (current.suspendedAt === null) return { result: current };
          const now = deps.clock();
          const updated = deps.store.resume(
            current.id,
            nextFire(current.schedule, current.tz, now),
            now,
          )!;
          return { result: updated, events: [changed(updated)] };
        });
        deps.scheduler.wake();
        return json({ automation } satisfies AutomationResponse);
      },
    },
    {
      method: "POST",
      path: "/api/automations/:id/run",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const row = visible(principal, ctx.params.id);
        const user = deps.users.byId(principal.userId);
        if (user === null) throw new BadRequest("the user is gone");
        return json(deps.scheduler.runNow(row, user), 201);
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
        editable(principal, found);
        transact(deps.db, () => {
          const current = visible(principal, found.id);
          editable(principal, current);
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
        const body: AutomationRunsResponse = deps.sessions.runs(
          automation.id,
          filter,
          before,
        );
        return json(body);
      },
    },
  ];
}
