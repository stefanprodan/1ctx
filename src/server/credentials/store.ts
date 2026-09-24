// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  HTTP_METHODS,
  type HttpMethod,
} from "../../shared/contracts/credential.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export type CredentialRow = {
  id: string;
  name: string;
  keyName: string;
  prefix: string;
  header: string;
  template: string;
  methods: HttpMethod[];
  // the team projects it is bound to, by id
  projectIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type CredentialFields = {
  keyName: string;
  prefix: string;
  header: string;
  template: string;
  methods: HttpMethod[];
};

type Raw = {
  id: string;
  name: string;
  key_name: string;
  prefix: string;
  header: string;
  template: string;
  methods: string;
  created_at: number;
  updated_at: number;
};

// one order, whatever order a request named them in
export const orderedMethods = (methods: Iterable<HttpMethod>): HttpMethod[] => {
  const set = new Set(methods);
  return HTTP_METHODS.filter((method) => set.has(method));
};

export class CredentialStore {
  constructor(private readonly db: Db) {}

  private rows(raws: Raw[]): CredentialRow[] {
    if (raws.length === 0) return [];
    const links = new Map<string, string[]>();
    const ids = raws.map((raw) => raw.id);
    const found = this.db
      .query<{ credential_id: string; project_id: string }, string[]>(
        `select credential_id, project_id from credential_projects
         where credential_id in (${ids.map(() => "?").join(", ")})
         order by project_id`,
      )
      .all(...ids);
    for (const link of found) {
      const list = links.get(link.credential_id) ?? [];
      list.push(link.project_id);
      links.set(link.credential_id, list);
    }
    return raws.map((raw) => ({
      id: raw.id,
      name: raw.name,
      keyName: raw.key_name,
      prefix: raw.prefix,
      header: raw.header,
      template: raw.template,
      methods: orderedMethods(JSON.parse(raw.methods) as HttpMethod[]),
      projectIds: links.get(raw.id) ?? [],
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }));
  }

  list(): CredentialRow[] {
    return this.rows(
      this.db.query<Raw, []>("select * from credentials order by name").all(),
    );
  }

  byId(id: string): CredentialRow | null {
    return (
      this.rows(
        this.db
          .query<Raw, [string]>("select * from credentials where id = ?")
          .all(id),
      )[0] ?? null
    );
  }

  byName(name: string): CredentialRow | null {
    return (
      this.rows(
        this.db
          .query<Raw, [string]>("select * from credentials where name = ?")
          .all(name),
      )[0] ?? null
    );
  }

  // the credentials bound to a project, in name order
  forProject(projectId: string): CredentialRow[] {
    return this.rows(
      this.db
        .query<Raw, [string]>(
          `select c.* from credentials c
           join credential_projects l on l.credential_id = c.id
           where l.project_id = ?
           order by c.name`,
        )
        .all(projectId),
    );
  }

  create(name: string, fields: CredentialFields, now: number): string {
    const id = newId();
    this.db
      .query(
        `insert into credentials (id, name, key_name, prefix, header,
           template, methods, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        fields.keyName,
        fields.prefix,
        fields.header,
        fields.template,
        JSON.stringify(orderedMethods(fields.methods)),
        now,
        now,
      );
    return id;
  }

  update(id: string, fields: CredentialFields, now: number): void {
    this.db
      .query(
        `update credentials set key_name = ?, prefix = ?, header = ?,
           template = ?, methods = ?, updated_at = ?
         where id = ?`,
      )
      .run(
        fields.keyName,
        fields.prefix,
        fields.header,
        fields.template,
        JSON.stringify(orderedMethods(fields.methods)),
        now,
        id,
      );
  }

  // the whole set, replacing what was bound
  setProjects(id: string, projectIds: readonly string[]): void {
    this.db
      .query("delete from credential_projects where credential_id = ?")
      .run(id);
    const insert = this.db.query(
      "insert into credential_projects (credential_id, project_id) values (?, ?)",
    );
    for (const projectId of new Set(projectIds)) insert.run(id, projectId);
  }

  delete(id: string): boolean {
    return (
      this.db.query("delete from credentials where id = ?").run(id).changes > 0
    );
  }
}
