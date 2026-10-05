// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  DiscoverResponse,
  SkillFileResponse,
  SkillLoads,
  SkillResponse,
  SkillsResponse,
} from "../../shared/api/skills.ts";
import { skillKey } from "../../shared/capabilities.ts";
import { cutCodePoints } from "../../shared/text.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import {
  Conflict,
  HttpError,
  messageOf,
  NotFound,
  ServiceUnavailable,
} from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { lastDays } from "../usage/index.ts";
import { MAX_REFRESH_ERROR } from "./limits.ts";
import { changeOf, discover, loadSkill } from "./load.ts";
import { parseAdd, parseDiscover, parseFile } from "./parse.ts";
import { loaded, type SkillRow, type SkillStore, summary } from "./store.ts";

export type AgentsPort = { agentNames(ids: string[]): string[] };
export type UsagePort = {
  loads(since: number, until: number): SkillLoads;
};
export type RoutesDeps = {
  db: Db;
  store: SkillStore;
  capabilities: { forget(key: string): void };
  agents: AgentsPort;
  usage: UsagePort;
  fetcher: typeof fetch;
  clock: Clock;
  log: Log;
  shutdown: AbortSignal;
  refreshing: Set<string>;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const show = (row: SkillRow) =>
    summary(row, deps.agents.agentNames(deps.store.usesSkill(row.id)));
  const find = (id: string) => {
    const row = deps.store.byId(id);
    if (row === null) throw new NotFound("no such skill");
    return row;
  };
  const response = (row: SkillRow): SkillResponse => ({
    skill: show(row),
    body: row.body,
  });
  const detail = (id: string): SkillResponse => {
    const body = deps.store.bodyOf(id);
    const skill = deps.store.summaryById(id, deps.agents.agentNames);
    if (body === null || skill === null) throw new NotFound("no such skill");
    return { skill, body: body.body };
  };
  return [
    {
      method: "GET",
      path: "/api/skills",
      policy: "admin",
      handle() {
        const body: SkillsResponse = {
          skills: deps.store.summaries(deps.agents.agentNames),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/skills/discover",
      policy: "admin",
      async handle(req) {
        const fields = parseDiscover(await jsonBody(req));
        const body: DiscoverResponse = await discover(
          deps.fetcher,
          fields.url,
          deps.shutdown,
        );
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/skills",
      policy: "admin",
      async handle(req) {
        const fields = parseAdd(await jsonBody(req));
        const selection =
          "name" in fields
            ? { name: fields.name, digest: fields.digest }
            : { path: fields.path };
        const skill = await loadSkill(
          deps.fetcher,
          fields.url,
          selection,
          deps.shutdown,
        );
        const row = deps.store.create(skill, deps.clock());
        return json(response(row), 201);
      },
    },
    {
      method: "GET",
      path: "/api/skills/:id/file",
      policy: "admin",
      handle(_req, ctx) {
        if (deps.store.nameOf(ctx.params.id) === null) {
          throw new NotFound("no such skill");
        }
        const path = parseFile(ctx.url);
        const file = deps.store.fileOf(ctx.params.id, path);
        if (file === null) throw new NotFound("no such skill file");
        const body: SkillFileResponse = file;
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/skills/:id",
      policy: "admin",
      handle(_req, ctx) {
        return json(detail(ctx.params.id));
      },
    },
    {
      method: "GET",
      path: "/api/usage/skills",
      policy: "admin",
      handle() {
        return json(
          lastDays(deps.clock(), (since, until) => {
            const { skills, ...all } = deps.usage.loads(since, until);
            return {
              ...all,
              skills: skills.map(({ files: _, ...skill }) => skill),
            };
          }),
        );
      },
    },
    {
      method: "GET",
      path: "/api/skills/:id/usage",
      policy: "admin",
      handle(_req, ctx) {
        const row = find(ctx.params.id);
        return json(
          lastDays(deps.clock(), (since, until) => {
            const one = deps.usage
              .loads(since, until)
              .skills.find((s) => s.name === row.name);
            return {
              loads: one?.loads ?? 0,
              reads: one?.reads ?? 0,
              failed: one?.failed ?? 0,
              files: one?.files ?? [],
            };
          }),
        );
      },
    },
    {
      method: "POST",
      path: "/api/skills/:id/refresh",
      policy: "admin",
      async handle(_req, ctx) {
        const before = find(ctx.params.id);
        if (deps.refreshing.has(before.id))
          throw new Conflict("the skill is refreshing");
        deps.refreshing.add(before.id);
        try {
          const selection =
            before.sourceKind === "index"
              ? { name: before.sourceSelect, digest: "" }
              : { path: before.sourceSelect };
          const next = await loadSkill(
            deps.fetcher,
            before.sourceUrl,
            selection,
            deps.shutdown,
          );
          if (next.name !== before.name) {
            throw new Conflict(
              `the URL now holds ${next.name}; add it as a new skill`,
            );
          }
          const change = changeOf(loaded(before), next, deps.clock());
          const row = deps.store.replace(
            before.id,
            next,
            change ?? before.lastChange,
            deps.clock(),
          );
          if (row === null) throw new NotFound("no such skill");
          return json(response(row));
        } catch (error) {
          if (error instanceof ServiceUnavailable) throw error;
          const words = messageOf(error);
          deps.store.refreshFailed(
            before.id,
            cutCodePoints(words, MAX_REFRESH_ERROR),
            deps.clock(),
          );
          deps.log.warn("skill refresh failed", {
            skill: before.name,
            ...errorFields(error, false),
            // the source's words may name its files; the status says
            // what failed, and the row keeps the words
            ...(error instanceof HttpError
              ? { error: "skill source refused" }
              : {}),
          });
          throw error;
        } finally {
          deps.refreshing.delete(before.id);
        }
      },
    },
    {
      method: "DELETE",
      path: "/api/skills/:id",
      policy: "admin",
      handle(_req, ctx) {
        const row = find(ctx.params.id);
        if (deps.refreshing.has(row.id))
          throw new Conflict("the skill is refreshing");
        // no agent has it, so its key in a chat or a task means nothing
        transact(deps.db, () => {
          deps.store.delete(row.id);
          deps.capabilities.forget(skillKey(row.id));
          return { result: undefined };
        });
        return json({});
      },
    },
  ];
}
