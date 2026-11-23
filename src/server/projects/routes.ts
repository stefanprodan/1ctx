// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SendTotals } from "../../shared/api/admin.ts";
import type {
  DeleteProjectResponse,
  ProjectResponse,
  ProjectShellResponse,
  ProjectsResponse,
} from "../../shared/api/projects.ts";
import type {
  KnowledgeCounts,
  KnowledgeFile,
} from "../../shared/contracts/knowledge.ts";
import type { ProjectDetail } from "../../shared/contracts/project.ts";
import type {
  SandboxBackend,
  SandboxVariant,
} from "../../shared/contracts/sandbox.ts";
import type { UserSummary } from "../../shared/contracts/user.ts";
import { LATEST_FILES } from "../../shared/knowledge.ts";
import { isRecord, RESERVED_PROJECT_NAMES } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import { accessChanged, type BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import { lastDays } from "../usage/index.ts";
import { type UserRow, summary as userSummary } from "../users/index.ts";
import { metadataRoutes } from "./metadata.ts";
import {
  parseAddMember,
  parseCreateProject,
  parseUpdateProject,
} from "./parse.ts";
import {
  type ProjectRow,
  type ProjectStore,
  summary,
  uniqueViolation,
} from "./store.ts";
import { visible } from "./visible.ts";

export type AccessPort = {
  project(principal: Principal, id: string): ProjectRow;
};

export type UsersPort = {
  byId(id: string): UserRow | null;
};

export type SessionsPort = {
  count(projectId: string): number;
  running(projectId: string): boolean;
  createChannel(projectId: string, name: string, now: number): void;
  renameChannel(projectId: string, name: string): BusEvent[];
  // in the caller's transaction: a member who left loses the messages
  // they had waiting in its chats, with the envelopes to publish
  dropQueued(projectId: string, userId: string): BusEvent[];
};

// The caller's transaction keeps membership and claims together.
export type TaskClaimsPort = {
  endForUser(userId: string, projectIds: readonly string[]): BusEvent[];
};

// how many external tasks carry each of the project's labels, by label
// id, closed ones too: an area built later
export type TaskLabelsPort = {
  labelTasks(projectId: string): Map<string, number>;
};

// the knowledge base's counts for the detail, an area built later
export type KnowledgePort = {
  counts(projectId: string): KnowledgeCounts;
  latest(projectId: string, limit: number): KnowledgeFile[];
};

export type UsagePort = {
  projectTotal(projectId: string, since: number, until: number): SendTotals;
};

// the instance's sandbox setting, which a project without a backend or
// variant of its own follows: an area built later
export type ShellPort = {
  instanceBackend(): SandboxBackend;
  // null while a custom image replaces every variant
  instanceVariant(): SandboxVariant | null;
  // a project's backend changed or a project went, after the commit
  changed(): void;
};

export type RoutesDeps = {
  db: Db;
  store: ProjectStore;
  access: AccessPort;
  users: UsersPort;
  sessions: SessionsPort;
  taskClaims: TaskClaimsPort;
  taskLabels: TaskLabelsPort;
  knowledge: KnowledgePort;
  usage: UsagePort;
  shell: ShellPort;
  clock: Clock;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const findTeam = (id: string): ProjectRow => {
    const project = deps.store.byId(id);
    if (project === null || project.kind !== "team") {
      throw new NotFound("no such project");
    }
    return project;
  };
  const detail = (project: ProjectRow): ProjectDetail => {
    const members: UserSummary[] = [];
    for (const id of deps.store.memberIds(project.id)) {
      const user = deps.users.byId(id);
      if (user !== null) members.push(userSummary(user));
    }
    // the Directory's order, the users table's byte order on username
    members.sort((a, b) =>
      a.username < b.username ? -1 : a.username > b.username ? 1 : 0,
    );
    const uses = deps.taskLabels.labelTasks(project.id);
    return {
      ...summary(project, members.length),
      description: project.description,
      members,
      labels: deps.store
        .labels(project.id)
        .map((label) => ({ ...label, tasks: uses.get(label.id) ?? 0 })),
      chats: deps.sessions.count(project.id),
      knowledge: deps.knowledge.counts(project.id),
      latestFiles: deps.knowledge.latest(project.id, LATEST_FILES),
      backend: project.backend,
      instanceBackend: deps.shell.instanceBackend(),
      variant: project.variant,
      instanceVariant: deps.shell.instanceVariant(),
    };
  };
  // a reserved name reads as taken, since a personal project holds it
  const nameAvailable = (name: string, exceptId?: string) => {
    if (
      RESERVED_PROJECT_NAMES.includes(name) ||
      deps.store.nameTaken(name, exceptId)
    ) {
      throw new Conflict("name is taken");
    }
  };
  function writeName<T>(write: () => T): T {
    try {
      return write();
    } catch (error) {
      if (uniqueViolation(error)) throw new Conflict("name is taken");
      throw error;
    }
  }
  return [
    ...metadataRoutes({
      db: deps.db,
      store: deps.store,
      access: deps.access,
      clock: deps.clock,
      detail,
    }),
    {
      method: "GET",
      path: "/api/projects",
      policy: "authenticated",
      handle(_req, ctx) {
        const principal = ctx.principal!;
        const body: ProjectsResponse = {
          projects: deps.store.visibleFor(
            principal.userId,
            principal.role === "admin",
          ),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/projects",
      policy: "admin",
      async handle(req, ctx) {
        const { name, description, labels } = parseCreateProject(
          await jsonBody(req),
        );
        const project = transact(deps.db, () => {
          nameAvailable(name);
          const created = writeName(() =>
            deps.store.createTeam({
              ownerId: ctx.principal!.userId,
              name,
              description,
              labels,
              now: deps.clock(),
            }),
          );
          deps.sessions.createChannel(created.id, created.name, deps.clock());
          return {
            result: detail(created),
            events: [accessChanged(null)],
          };
        });
        const body: ProjectResponse = { project };
        return json(body, 201);
      },
    },
    {
      method: "GET",
      path: "/api/projects/:id",
      policy: "authenticated",
      handle(_req, ctx) {
        const project = deps.access.project(ctx.principal!, ctx.params.id);
        const body: ProjectResponse = { project: detail(project) };
        return json(body);
      },
    },
    {
      method: "PATCH",
      path: "/api/projects/:id",
      policy: "admin",
      async handle(req, ctx) {
        // a personal project's shell is an admin's too, and nothing else
        // of it is: any other field, a bad one included, is a 404 there
        const editable = (body: unknown): ProjectRow => {
          const project = deps.store.byId(ctx.params.id);
          const shellOnly =
            isRecord(body) &&
            Object.keys(body).every(
              (field) => field === "backend" || field === "variant",
            );
          if (project === null || (project.kind !== "team" && !shellOnly)) {
            throw new NotFound("no such project");
          }
          return project;
        };
        editable({});
        const sent = await jsonBody(req);
        editable(sent);
        const change = parseUpdateProject(sent);
        const project = transact(deps.db, () => {
          const current = editable(sent);
          let updated: ProjectRow | null = current;
          let events: BusEvent[] = [];
          if (change.name !== undefined || change.description !== undefined) {
            const name = change.name ?? current.name;
            nameAvailable(name, current.id);
            updated = writeName(() =>
              deps.store.update(current.id, {
                name,
                description: change.description ?? current.description,
              }),
            );
            if (updated !== null) {
              events = deps.sessions.renameChannel(updated.id, updated.name);
            }
          }
          // the next command picks the shell: nothing to drain
          if (updated !== null && change.backend !== undefined) {
            updated = deps.store.setBackend(current.id, change.backend);
          }
          // its next command takes the new image: nothing to drain
          if (updated !== null && change.variant !== undefined) {
            updated = deps.store.setVariant(current.id, change.variant);
          }
          if (updated === null) throw new NotFound("no such project");
          return { result: updated, events };
        });
        if (change.backend !== undefined) deps.shell.changed();
        // another user's personal project: what changed alone, since its
        // admin may not read the rest
        if (!visible(project, ctx.principal!, false)) {
          const own: ProjectShellResponse = {
            id: project.id,
            backend: project.backend,
            variant: project.variant,
          };
          return json(own);
        }
        const body: ProjectResponse = { project: detail(project) };
        return json(body);
      },
    },
    {
      method: "DELETE",
      path: "/api/projects/:id",
      policy: "admin",
      handle(_req, ctx) {
        const deleted = transact(deps.db, () => {
          const project = findTeam(ctx.params.id);
          if (deps.sessions.running(project.id)) {
            throw new Conflict("project has a running chat");
          }
          const chats = deps.sessions.count(project.id);
          if (!deps.store.remove(project.id)) {
            throw new NotFound("no such project");
          }
          return {
            result: chats,
            events: [
              accessChanged(null),
              {
                type: "project.deleted" as const,
                data: { projectId: project.id },
              },
            ],
          };
        });
        deps.shell.changed();
        const body: DeleteProjectResponse = { deleted };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/projects/:id/usage",
      policy: "admin",
      handle(_req, ctx) {
        const project = findTeam(ctx.params.id);
        return json(
          lastDays(deps.clock(), (since, until) =>
            deps.usage.projectTotal(project.id, since, until),
          ),
        );
      },
    },
    {
      method: "POST",
      path: "/api/projects/:id/members",
      policy: "admin",
      async handle(req, ctx) {
        findTeam(ctx.params.id);
        const { userId } = parseAddMember(await jsonBody(req));
        const project = transact(deps.db, () => {
          const current = findTeam(ctx.params.id);
          if (deps.users.byId(userId) === null) {
            throw new NotFound("userId does not name a user");
          }
          if (deps.store.isMember(current.id, userId)) {
            throw new Conflict("userId is already a member");
          }
          try {
            deps.store.addMember(current.id, userId, deps.clock());
          } catch (error) {
            if (uniqueViolation(error)) {
              throw new Conflict("userId is already a member");
            }
            throw error;
          }
          return {
            result: detail(current),
            events: [accessChanged([userId])],
          };
        });
        const body: ProjectResponse = { project };
        return json(body, 201);
      },
    },
    {
      method: "DELETE",
      path: "/api/projects/:id/members/:userId",
      policy: "admin",
      handle(_req, ctx) {
        const project = transact(deps.db, () => {
          const current = findTeam(ctx.params.id);
          const user = deps.users.byId(ctx.params.userId);
          if (user === null) {
            throw new NotFound("userId does not name a user");
          }
          if (!deps.store.removeMember(current.id, ctx.params.userId)) {
            throw new Conflict("userId is not a member");
          }
          return {
            result: detail(current),
            events: [
              ...deps.sessions.dropQueued(current.id, ctx.params.userId),
              accessChanged([ctx.params.userId]),
              ...(user.role === "admin"
                ? []
                : deps.taskClaims.endForUser(user.id, [current.id])),
            ],
          };
        });
        const body: ProjectResponse = { project };
        return json(body);
      },
    },
  ];
}
