// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ProjectSummary } from "../../shared/contracts/project.ts";
import type { ProjectKind } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export type ProjectRow = {
  id: string;
  kind: ProjectKind;
  name: string;
  ownerId: string;
  createdAt: number;
  description: string;
};

type Raw = {
  id: string;
  kind: ProjectKind;
  name: string;
  owner_id: string;
  created_at: number;
  description: string;
};

const row = (raw: Raw): ProjectRow => ({
  id: raw.id,
  kind: raw.kind,
  name: raw.name,
  ownerId: raw.owner_id,
  createdAt: raw.created_at,
  description: raw.description,
});

export const summary = (
  project: ProjectRow,
  memberCount: number,
): ProjectSummary => ({
  id: project.id,
  kind: project.kind,
  name: project.name,
  createdAt: project.createdAt,
  memberCount,
});

export class ProjectStore {
  constructor(private readonly db: Db) {}

  byId(id: string): ProjectRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from projects where id = ?")
      .get(id);
    return raw ? row(raw) : null;
  }

  visibleFor(userId: string, admin: boolean): ProjectSummary[] {
    return this.db
      .query<Raw & { member_count: number }, [string, number, string]>(
        `select p.*,
                (select count(*) from memberships c where c.project_id = p.id)
                  as member_count
         from projects p
         where (p.kind = 'personal' and p.owner_id = ?)
            or (p.kind = 'team' and
                (? = 1 or exists (
                  select 1 from memberships m
                  where m.project_id = p.id and m.user_id = ?
                )))
         order by p.kind = 'personal' desc, p.name`,
      )
      .all(userId, admin ? 1 : 0, userId)
      .map((raw) => summary(row(raw), raw.member_count));
  }

  memberProjectIds(userId: string): string[] {
    return this.db
      .query<{ project_id: string }, [string]>(
        "select project_id from memberships where user_id = ?",
      )
      .all(userId)
      .map((r) => r.project_id);
  }

  teamProjectIds(): string[] {
    return this.db
      .query<{ id: string }, []>("select id from projects where kind = 'team'")
      .all()
      .map((r) => r.id);
  }

  personal(userId: string): ProjectRow | null {
    const raw = this.db
      .query<Raw, [string]>(
        "select * from projects where owner_id = ? and kind = 'personal'",
      )
      .get(userId);
    return raw ? row(raw) : null;
  }

  isMember(projectId: string, userId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string, string]>(
          "select count(*) as n from memberships where project_id = ? and user_id = ?",
        )
        .get(projectId, userId)!.n > 0
    );
  }

  memberIds(projectId: string): string[] {
    return this.db
      .query<{ user_id: string }, [string]>(
        "select user_id from memberships where project_id = ? order by created_at, user_id",
      )
      .all(projectId)
      .map((r) => r.user_id);
  }

  nameTaken(name: string, exceptId?: string): boolean {
    const found =
      exceptId === undefined
        ? this.db
            .query<{ n: number }, [string]>(
              "select count(*) as n from projects where name = ?",
            )
            .get(name)!.n
        : this.db
            .query<{ n: number }, [string, string]>(
              "select count(*) as n from projects where name = ? and id != ?",
            )
            .get(name, exceptId)!.n;
    return found > 0;
  }

  createTeam(fields: {
    ownerId: string;
    name: string;
    description: string;
    now: number;
  }): ProjectRow {
    const id = newId();
    this.db
      .query(
        "insert into projects (id, kind, name, description, owner_id, created_at) values (?, 'team', ?, ?, ?, ?)",
      )
      .run(id, fields.name, fields.description, fields.ownerId, fields.now);
    return this.byId(id)!;
  }

  update(
    id: string,
    fields: { name: string; description: string },
  ): ProjectRow | null {
    this.db
      .query(
        "update projects set name = ?, description = ? where id = ? and kind = 'team'",
      )
      .run(fields.name, fields.description, id);
    return this.byId(id);
  }

  remove(id: string): boolean {
    return (
      this.db
        .query("delete from projects where id = ? and kind = 'team'")
        .run(id).changes > 0
    );
  }

  addMember(projectId: string, userId: string, now: number): void {
    this.db
      .query(
        "insert into memberships (project_id, user_id, created_at) values (?, ?, ?)",
      )
      .run(projectId, userId, now);
  }

  removeMember(projectId: string, userId: string): boolean {
    return (
      this.db
        .query("delete from memberships where project_id = ? and user_id = ?")
        .run(projectId, userId).changes > 0
    );
  }

  // the caller owns the surrounding user rename transaction; a name the
  // owner picked stays
  renamePersonal(userId: string, from: string, to: string): void {
    this.db
      .query(
        "update projects set name = ? where owner_id = ? and kind = 'personal' and name = ?",
      )
      .run(to, userId, from);
  }

  updatePersonal(
    userId: string,
    fields: { name: string; description: string },
  ): ProjectRow | null {
    this.db
      .query(
        "update projects set name = ?, description = ? where owner_id = ? and kind = 'personal'",
      )
      .run(fields.name, fields.description, userId);
    return this.personal(userId);
  }

  // the user and their project must either both exist or neither does
  createPersonal(fields: { userId: string; name: string; now: number }) {
    const id = newId();
    this.db
      .query(
        "insert into projects (id, kind, name, owner_id, created_at) values (?, 'personal', ?, ?, ?)",
      )
      .run(id, fields.name, fields.userId, fields.now);
    this.db
      .query(
        "insert into memberships (project_id, user_id, created_at) values (?, ?, ?)",
      )
      .run(id, fields.userId, fields.now);
    return this.byId(id)!;
  }
}
