// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SwitchableSkill } from "../../shared/api/sessions.ts";
import type { OfferedSkill } from "../../shared/contracts/skill.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import { type AgentsPort, routes } from "./routes.ts";
import { SkillStore } from "./store.ts";
import { switchable } from "./switchable.ts";

export { cleanText } from "./clean.ts";
export { fetchSource, fetchText } from "./fetch.ts";
export { type ParsedSkill, parseSkillMd } from "./frontmatter.ts";
export * from "./limits.ts";
export { changeOf, discover, type LoadedSkill, loadSkill } from "./load.ts";
export { parseAdd, parseDiscover, parseFile } from "./parse.ts";
export { parseIndex, pick, resolve, validPath } from "./source.ts";
export { type SkillRow, SkillStore, summary } from "./store.ts";

export type SkillsDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  fetcher: typeof fetch;
  agents: AgentsPort;
  // takes a deleted skill's key out of every disabled set; a closure,
  // since sessions and automations are built later
  capabilities: { forget(key: string): void };
};

export type SkillBody = {
  id: string;
  name: string;
  compatibility: string;
  body: string;
  files: string[];
};

export type Skills = {
  store: SkillStore;
  routes: RouteDescriptor[];
  forAgent(agentId: string): OfferedSkill[];
  switchable(): Record<string, SwitchableSkill[]>;
  versions(
    agentId: string,
  ): { id: string; digest: string; fetchedAt: number }[];
  bodyText(id: string): string | null;
  body(id: string, name: string): SkillBody | null;
  file(id: string, name: string, path: string): string | null;
  exists(id: string): boolean;
  assign(agentId: string, ids: string[]): void;
  assigned(agentId: string): string[];
  close(): void;
};

export function skillsArea(deps: SkillsDeps): Skills {
  const shutdown = new AbortController();
  const refreshing = new Set<string>();
  const store = new SkillStore(deps.db, deps.agents.agentNames);
  return {
    store,
    routes: routes({
      ...deps,
      store,
      shutdown: shutdown.signal,
      refreshing,
    }),
    forAgent: (agentId) => store.forAgent(agentId),
    switchable: () => switchable(deps.db),
    versions: (agentId) => store.versions(agentId),
    bodyText: (id) => store.bodyText(id),
    body(id, name) {
      const row = store.bodyOf(id);
      if (row === null || row.name !== name) return null;
      return {
        id: row.id,
        name: row.name,
        compatibility: row.compatibility,
        body: row.body,
        files: row.files,
      };
    },
    file(id, name, path) {
      if (store.nameOf(id) !== name) return null;
      return store.fileOf(id, path)?.content ?? null;
    },
    exists: (id) => store.nameOf(id) !== null,
    assign: (agentId, ids) => store.assign(agentId, ids),
    assigned: (agentId) => store.assigned(agentId),
    close: () => shutdown.abort(),
  };
}
