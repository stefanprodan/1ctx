// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ProjectSummary } from "../../shared/contracts/project.ts";
import type { ProjectKind } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export type ProjectRow = ProjectSummary & {
  ownerId: string;
  createdAt: number;
};

type Raw = {
  id: string;
  kind: ProjectKind;
  name: string;
  owner_id: string;
  created_at: number;
};

const row = (raw: Raw): ProjectRow => ({
  id: raw.id,
  kind: raw.kind,
  name: raw.name,
  ownerId: raw.owner_id,
  createdAt: raw.created_at,
});

export const summary = (project: ProjectRow): ProjectSummary => ({
  id: project.id,
  kind: project.kind,
  name: project.name,
});

export class ProjectStore {
  constructor(private readonly db: Db) {}

  byId(id: string): ProjectRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from projects where id = ?")
      .get(id);
    return raw ? row(raw) : null;
  }

  // the projects a user is a member of: the personal one first, then
  // the rest by name
  forUser(userId: string): ProjectRow[] {
    return this.db
      .query<Raw, [string]>(
        `select p.* from projects p
         join memberships m on m.project_id = p.id
         where m.user_id = ?
         order by p.kind = 'personal' desc, p.name`,
      )
      .all(userId)
      .map(row);
  }

  // the ids a user is a member of, and the team projects an admin sees
  // without being one; the two halves of the visible set
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

  // the personal project of a user, with the user as its one member;
  // called inside the transaction that creates the user
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
