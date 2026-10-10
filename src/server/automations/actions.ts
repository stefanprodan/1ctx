// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SaveAutomationRequest } from "../../shared/api/automations.ts";
import {
  type AutomationSummary,
  STALE_EDIT,
} from "../../shared/contracts/automation.ts";
import type { AgentRow } from "../agents/index.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import type { Limits } from "../limits/index.ts";
import type { ProjectRow } from "../projects/index.ts";
import type { PreparedRun } from "../runner/index.ts";
import type { UserRow } from "../users/index.ts";
import type { parsePatchAutomation } from "./parse.ts";
import { checkSchedule, nextFire } from "./schedule.ts";
import type { Scheduler } from "./scheduler.ts";
import {
  type AutomationStore,
  automationChanged,
  MAX_AUTOMATIONS_PER_PROJECT,
  RETIRED,
} from "./store.ts";

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
};

export type ActionsDeps = {
  db: Db;
  clock: Clock;
  store: AutomationStore;
  scheduler: Scheduler;
  access: AccessPort;
  agents: { byId(id: string): AgentRow | null };
  users: { byId(id: string): UserRow | null };
  limits: { current(): Limits };
};

export type AutomationActions = {
  visible(principal: Principal, id: string): AutomationSummary;
  create(
    principal: Principal,
    projectId: string,
    body: Required<SaveAutomationRequest>,
  ): AutomationSummary;
  update(
    principal: Principal,
    id: string,
    body: ReturnType<typeof parsePatchAutomation>,
  ): AutomationSummary;
  suspend(principal: Principal, id: string): AutomationSummary;
  resume(principal: Principal, id: string): AutomationSummary;
  run(principal: Principal, id: string): PreparedRun;
};

const changes = (
  current: AutomationSummary,
  patch: Partial<AutomationSummary>,
) =>
  (Object.keys(patch) as (keyof AutomationSummary)[]).some((key) => {
    const was = current[key];
    const now = patch[key];
    return Array.isArray(was) && Array.isArray(now)
      ? was.join("\n") !== now.join("\n")
      : was !== now;
  });

export function automationActions(deps: ActionsDeps): AutomationActions {
  const visible = (principal: Principal, id: string) => {
    const row = deps.store.byId(id);
    if (row === null) throw new NotFound("no such automation");
    deps.access.project(principal, row.projectId);
    return row;
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
  return {
    visible,
    create(principal, projectId, body) {
      const project = deps.access.project(principal, projectId);
      agent(body.agentId);
      deadline(body.deadlineMs);
      const now = deps.clock();
      const nextAt = checkSchedule(body.schedule, body.tz, now);
      return transact(deps.db, () => {
        deps.access.project(principal, project.id);
        agent(body.agentId);
        deadline(body.deadlineMs);
        if (deps.store.count(project.id) >= MAX_AUTOMATIONS_PER_PROJECT) {
          throw new Conflict("project has too many automations");
        }
        if (deps.store.nameTaken(project.id, body.name)) {
          throw new Conflict("name is taken");
        }
        const created = deps.store.create({
          ...body,
          projectId: project.id,
          ownerId: principal.userId,
          nextAt,
          now,
        });
        return { result: created, events: [automationChanged(created)] };
      });
    },
    update(principal, id, { patch, editRevision }) {
      const found = visible(principal, id);
      return transact(deps.db, () => {
        const current = visible(principal, found.id);
        // a fire, a run's end or an alert moves revision, never this
        if (current.editRevision !== editRevision)
          throw new Conflict(STALE_EDIT);
        const next = { ...current, ...patch };
        if (next.agentId === current.agentId && current.agentRetired) {
          throw new Conflict(RETIRED);
        }
        agent(next.agentId);
        deadline(next.deadlineMs);
        if (deps.store.nameTaken(current.projectId, next.name, current.id)) {
          throw new Conflict("name is taken");
        }
        const now = deps.clock();
        checkSchedule(next.schedule, next.tz, now);
        // a save that changes nothing keeps the owner and writes nothing
        if (!changes(current, patch)) return { result: current };
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
          ...next,
          ownerId: principal.userId,
          nextAt,
          now,
        })!;
        return { result: updated, events: [automationChanged(updated)] };
      });
    },
    suspend(principal, id) {
      const found = visible(principal, id);
      return transact(deps.db, () => {
        const current = visible(principal, found.id);
        if (current.suspendedAt !== null) return { result: current };
        const updated = deps.store.suspend(
          current.id,
          principal.userId,
          deps.clock(),
        )!;
        return { result: updated, events: [automationChanged(updated)] };
      });
    },
    resume(principal, id) {
      const found = visible(principal, id);
      return transact(deps.db, () => {
        const current = visible(principal, found.id);
        if (current.suspendedAt === null) return { result: current };
        if (current.agentRetired) throw new Conflict(RETIRED);
        const now = deps.clock();
        const updated = deps.store.resume(
          current.id,
          nextFire(current.schedule, current.tz, now),
          now,
        )!;
        return { result: updated, events: [automationChanged(updated)] };
      });
    },
    run(principal, id) {
      const row = visible(principal, id);
      const user = deps.users.byId(principal.userId);
      if (user === null) throw new BadRequest("the user is gone");
      return deps.scheduler.prepareNow(row, user);
    },
  };
}
