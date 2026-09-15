// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SkillSummary } from "../../shared/contracts/skill.ts";
import type { SkillSource } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { Conflict } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { LoadedSkill } from "./load.ts";

export type SkillRow = {
  id: string;
  name: string;
  description: string;
  body: string;
  license: string;
  compatibility: string;
  metadata: Record<string, string>;
  allowedTools: string;
  sourceKind: SkillSource;
  sourceUrl: string;
  sourceSelect: string;
  sourceDigest: string;
  digest: string;
  dropped: SkillSummary["dropped"];
  droppedMore: number;
  fetchedAt: number;
  lastChange: SkillSummary["lastChange"];
  refreshError: string | null;
  refreshFailedAt: number | null;
  createdAt: number;
  files: { path: string; content: string; bytes: number }[];
};

type Raw = {
  id: string;
  name: string;
  description: string;
  body: string;
  license: string;
  compatibility: string;
  metadata: string;
  allowed_tools: string;
  source_kind: SkillSource;
  source_url: string;
  source_select: string;
  source_digest: string;
  digest: string;
  dropped: string;
  fetched_at: number;
  last_change: string | null;
  refresh_error: string | null;
  refresh_failed_at: number | null;
  created_at: number;
};

type FileRaw = { path: string; content: string; bytes: number };
type DroppedStored = SkillSummary["dropped"][number] & { more?: number };

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class SkillStore {
  constructor(
    private readonly db: Db,
    private readonly agentNames: (ids: string[]) => string[],
  ) {}

  private row(raw: Raw): SkillRow {
    const stored = parseJson<DroppedStored[]>(raw.dropped, []);
    const more = stored.find((item) => item.more !== undefined)?.more ?? 0;
    const dropped = stored
      .filter((item) => item.more === undefined)
      .map(({ path, reason }) => ({ path, reason }));
    const files = this.db
      .query<FileRaw, [string]>(
        "select path, content, bytes from skill_files where skill_id = ? order by path",
      )
      .all(raw.id);
    return {
      id: raw.id,
      name: raw.name,
      description: raw.description,
      body: raw.body,
      license: raw.license,
      compatibility: raw.compatibility,
      metadata: parseJson(raw.metadata, {}),
      allowedTools: raw.allowed_tools,
      sourceKind: raw.source_kind,
      sourceUrl: raw.source_url,
      sourceSelect: raw.source_select,
      sourceDigest: raw.source_digest,
      digest: raw.digest,
      dropped,
      droppedMore: more,
      fetchedAt: raw.fetched_at,
      lastChange:
        raw.last_change === null ? null : parseJson(raw.last_change, null),
      refreshError: raw.refresh_error,
      refreshFailedAt: raw.refresh_failed_at,
      createdAt: raw.created_at,
      files,
    };
  }

  list(): SkillRow[] {
    return this.db
      .query<Raw, []>("select * from skills order by created_at, name")
      .all()
      .map((raw) => this.row(raw));
  }

  // the list route: every row as a summary without loading the body
  // text or any file content, so twenty skills of 20 KB stay light.
  // bodyBytes is the UTF-8 byte length from SQLite, file bytes are the
  // stored column
  summaries(agentNames: (ids: string[]) => string[]): SkillSummary[] {
    type LightRaw = Omit<Raw, "body"> & { body_bytes: number };
    const rows = this.db
      .query<LightRaw, []>(
        `select id, name, description, license, compatibility, metadata,
                allowed_tools, source_kind, source_url, source_select,
                source_digest, digest, dropped, fetched_at, last_change,
                refresh_error, refresh_failed_at, created_at,
                length(cast(body as blob)) as body_bytes
           from skills order by created_at, name`,
      )
      .all();
    const filesFor = this.db.query<{ path: string; bytes: number }, [string]>(
      "select path, bytes from skill_files where skill_id = ? order by path",
    );
    const usedBy = this.db.query<{ agent_id: string }, [string]>(
      "select agent_id from agent_skills where skill_id = ? order by agent_id",
    );
    return rows.map((raw) => {
      const stored = parseJson<DroppedStored[]>(raw.dropped, []);
      const more = stored.find((item) => item.more !== undefined)?.more ?? 0;
      const dropped = stored
        .filter((item) => item.more === undefined)
        .map(({ path, reason }) => ({ path, reason }));
      const agents = agentNames(usedBy.all(raw.id).map((row) => row.agent_id));
      return {
        id: raw.id,
        name: raw.name,
        description: raw.description,
        license: raw.license,
        compatibility: raw.compatibility,
        metadata: parseJson(raw.metadata, {}),
        allowedTools: raw.allowed_tools,
        sourceKind: raw.source_kind,
        sourceUrl: raw.source_url,
        sourceSelect: raw.source_select,
        sourceDigest: raw.source_digest,
        digest: raw.digest,
        bodyBytes: raw.body_bytes,
        files: filesFor.all(raw.id),
        dropped,
        droppedMore: more,
        fetchedAt: raw.fetched_at,
        lastChange:
          raw.last_change === null ? null : parseJson(raw.last_change, null),
        refreshError: raw.refresh_error,
        refreshFailedAt: raw.refresh_failed_at,
        agents,
        createdAt: raw.created_at,
      };
    });
  }

  // the skill body and its file paths, without loading any file content:
  // the `skill` tool reads the body but names the files, never reads them
  // the SKILL.md text alone, for a count of its tokens
  bodyText(id: string): string | null {
    return (
      this.db
        .query<{ body: string }, [string]>(
          "select body from skills where id = ?",
        )
        .get(id)?.body ?? null
    );
  }

  bodyOf(id: string): {
    id: string;
    name: string;
    compatibility: string;
    body: string;
    files: string[];
  } | null {
    const raw = this.db
      .query<
        { id: string; name: string; compatibility: string; body: string },
        [string]
      >("select id, name, compatibility, body from skills where id = ?")
      .get(id);
    if (raw === null) return null;
    const files = this.db
      .query<{ path: string }, [string]>(
        "select path from skill_files where skill_id = ? order by path",
      )
      .all(id)
      .map((row) => row.path);
    return { ...raw, files };
  }

  summaryById(
    id: string,
    agentNames: (ids: string[]) => string[],
  ): SkillSummary | null {
    return this.summaries(agentNames).find((row) => row.id === id) ?? null;
  }

  fileOf(id: string, path: string): FileRaw | null {
    return this.db
      .query<FileRaw, [string, string]>(
        `select path, content, bytes from skill_files
          where skill_id = ? and path = ?`,
      )
      .get(id, path);
  }

  nameOf(id: string): string | null {
    const raw = this.db
      .query<{ name: string }, [string]>("select name from skills where id = ?")
      .get(id);
    return raw?.name ?? null;
  }

  byId(id: string): SkillRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from skills where id = ?")
      .get(id);
    return raw ? this.row(raw) : null;
  }

  byName(name: string): SkillRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from skills where name = ?")
      .get(name);
    return raw ? this.row(raw) : null;
  }

  private dropped(skill: LoadedSkill): string {
    const rows: DroppedStored[] = skill.dropped.slice();
    if (skill.droppedMore > 0)
      rows.push({ path: "", reason: "", more: skill.droppedMore });
    return JSON.stringify(rows);
  }

  private insertFiles(id: string, skill: LoadedSkill): void {
    const insert = this.db.query(
      "insert into skill_files (skill_id, path, content, bytes) values (?, ?, ?, ?)",
    );
    for (const file of skill.files)
      insert.run(id, file.path, file.content, file.bytes);
  }

  create(skill: LoadedSkill, now: number): SkillRow {
    return transact(this.db, () => {
      if (this.byName(skill.name)) {
        throw new Conflict(`a skill named ${skill.name} exists`);
      }
      const id = newId();
      this.db
        .query(
          `insert into skills
             (id, name, description, body, license, compatibility, metadata,
              allowed_tools, source_kind, source_url, source_select,
              source_digest, digest, dropped, fetched_at, last_change,
              refresh_error, refresh_failed_at, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null,
                   null, ?)`,
        )
        .run(
          id,
          skill.name,
          skill.description,
          skill.body,
          skill.license,
          skill.compatibility,
          JSON.stringify(skill.metadata),
          skill.allowedTools,
          skill.sourceKind,
          skill.sourceUrl,
          skill.sourceSelect,
          skill.sourceDigest,
          skill.digest,
          this.dropped(skill),
          now,
          now,
        );
      this.insertFiles(id, skill);
      return { result: this.byId(id)! };
    });
  }

  replace(
    id: string,
    skill: LoadedSkill,
    lastChange: SkillSummary["lastChange"],
    now: number,
  ): SkillRow | null {
    return transact(this.db, () => {
      const current = this.byId(id);
      if (current === null) return { result: null };
      this.db
        .query(
          `update skills set description = ?, body = ?, license = ?,
             compatibility = ?, metadata = ?, allowed_tools = ?,
             source_kind = ?, source_url = ?, source_select = ?,
             source_digest = ?, digest = ?, dropped = ?, fetched_at = ?,
             last_change = ?, refresh_error = null, refresh_failed_at = null
           where id = ?`,
        )
        .run(
          skill.description,
          skill.body,
          skill.license,
          skill.compatibility,
          JSON.stringify(skill.metadata),
          skill.allowedTools,
          skill.sourceKind,
          skill.sourceUrl,
          skill.sourceSelect,
          skill.sourceDigest,
          skill.digest,
          this.dropped(skill),
          now,
          lastChange === null ? null : JSON.stringify(lastChange),
          id,
        );
      this.db.query("delete from skill_files where skill_id = ?").run(id);
      this.insertFiles(id, skill);
      return { result: this.byId(id) };
    });
  }

  refreshFailed(id: string, error: string, now: number): void {
    this.db
      .query(
        "update skills set refresh_error = ?, refresh_failed_at = ? where id = ?",
      )
      .run(error, now, id);
  }

  usesSkill(id: string): string[] {
    return this.db
      .query<{ agent_id: string }, [string]>(
        "select agent_id from agent_skills where skill_id = ? order by agent_id",
      )
      .all(id)
      .map((row) => row.agent_id);
  }

  delete(id: string): boolean {
    return transact(this.db, () => {
      const ids = this.usesSkill(id);
      if (ids.length > 0) {
        const names = this.agentNames(ids);
        throw new Conflict(`used by ${names.join(", ") || "an agent"}`);
      }
      const changed = this.db
        .query("delete from skills where id = ?")
        .run(id).changes;
      return { result: changed > 0 };
    });
  }

  forAgent(agentId: string) {
    return this.db
      .query<
        { id: string; name: string; description: string; has_files: number },
        [string]
      >(
        `select s.id, s.name, s.description,
                exists(select 1 from skill_files f where f.skill_id = s.id) as has_files
           from skills s join agent_skills a on a.skill_id = s.id
          where a.agent_id = ? order by s.name`,
      )
      .all(agentId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        hasFiles: row.has_files === 1,
      }));
  }

  // the agent's skills as its page needs them without their bodies: when
  // each was fetched, and its digest, which moves with its content, so a
  // count taken from the body can be kept until it does
  versions(
    agentId: string,
  ): { id: string; digest: string; fetchedAt: number }[] {
    return this.db
      .query<{ id: string; digest: string; fetched_at: number }, [string]>(
        `select s.id, s.digest, s.fetched_at
           from skills s join agent_skills a on a.skill_id = s.id
          where a.agent_id = ? order by s.name`,
      )
      .all(agentId)
      .map((row) => ({
        id: row.id,
        digest: row.digest,
        fetchedAt: row.fetched_at,
      }));
  }

  assign(agentId: string, ids: string[]): void {
    transact(this.db, () => {
      this.db.query("delete from agent_skills where agent_id = ?").run(agentId);
      const insert = this.db.query(
        "insert into agent_skills (agent_id, skill_id) values (?, ?)",
      );
      for (const id of ids) insert.run(agentId, id);
      return { result: undefined };
    });
  }

  assigned(agentId: string): string[] {
    return this.db
      .query<{ skill_id: string }, [string]>(
        `select a.skill_id from agent_skills a join skills s on s.id = a.skill_id
          where a.agent_id = ? order by s.name`,
      )
      .all(agentId)
      .map((row) => row.skill_id);
  }
}

export function summary(row: SkillRow, agents: string[]): SkillSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    license: row.license,
    compatibility: row.compatibility,
    metadata: row.metadata,
    allowedTools: row.allowedTools,
    sourceKind: row.sourceKind,
    sourceUrl: row.sourceUrl,
    sourceSelect: row.sourceSelect,
    sourceDigest: row.sourceDigest,
    digest: row.digest,
    bodyBytes: new TextEncoder().encode(row.body).byteLength,
    files: row.files.map(({ path, bytes }) => ({ path, bytes })),
    dropped: row.dropped,
    droppedMore: row.droppedMore,
    fetchedAt: row.fetchedAt,
    lastChange: row.lastChange,
    refreshError: row.refreshError,
    refreshFailedAt: row.refreshFailedAt,
    agents,
    createdAt: row.createdAt,
  };
}

export function loaded(row: SkillRow): LoadedSkill {
  return {
    name: row.name,
    description: row.description,
    body: row.body,
    license: row.license,
    compatibility: row.compatibility,
    metadata: row.metadata,
    allowedTools: row.allowedTools,
    sourceKind: row.sourceKind,
    sourceUrl: row.sourceUrl,
    sourceSelect: row.sourceSelect,
    sourceDigest: row.sourceDigest,
    digest: row.digest,
    dropped: row.dropped,
    droppedMore: row.droppedMore,
    files: row.files,
  };
}
