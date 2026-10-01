// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { RepoView } from "../../shared/api/repos.ts";
import type {
  RepoError,
  RepoKind,
  RepoState,
} from "../../shared/contracts/repo.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export type RepoRow = RepoView & {
  projectId: string;
  // the ETag of the last lookup or archive answer, sent back to get a 304
  etag: string | null;
};

// what an admin or an owner writes
export type RepoFields = {
  name: string;
  url: string;
  kind: RepoKind;
  ref: string;
  credentialId: string | null;
  ignore: string;
};

// what a fetch leaves on the row
export type RepoFetched = {
  state: RepoState;
  error: RepoError | null;
  etag?: string | null;
  commit?: string | null;
  fetchedAt?: number | null;
  files?: number | null;
  bytes?: number | null;
  ignored?: number | null;
};

type Raw = {
  id: string;
  project_id: string;
  name: string;
  url: string;
  kind: RepoKind;
  ref: string;
  credential_id: string | null;
  ignore_rules: string;
  state: RepoState;
  error: RepoError | null;
  etag: string | null;
  commit_id: string | null;
  fetched_at: number | null;
  files: number | null;
  bytes: number | null;
  ignored: number | null;
  created_at: number;
  updated_at: number;
};

const row = (raw: Raw): RepoRow => ({
  id: raw.id,
  projectId: raw.project_id,
  name: raw.name,
  url: raw.url,
  kind: raw.kind,
  ref: raw.ref,
  credentialId: raw.credential_id,
  ignore: raw.ignore_rules,
  state: raw.state,
  error: raw.error,
  etag: raw.etag,
  commit: raw.commit_id,
  fetchedAt: raw.fetched_at,
  files: raw.files,
  bytes: raw.bytes,
  ignored: raw.ignored,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

// the wire's view: the ETag and the project stay on the server
export function view(repo: RepoRow): RepoView {
  const { projectId: _projectId, etag: _etag, ...rest } = repo;
  return rest;
}

export class ReposStore {
  constructor(private readonly db: Db) {}

  byId(id: string): RepoRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from repos where id = ?")
      .get(id);
    return raw ? row(raw) : null;
  }

  // one of a project's, null for another project's
  inProject(projectId: string, id: string): RepoRow | null {
    const raw = this.db
      .query<Raw, [string, string]>(
        "select * from repos where project_id = ? and id = ?",
      )
      .get(projectId, id);
    return raw ? row(raw) : null;
  }

  // a project's, in name order
  forProject(projectId: string): RepoRow[] {
    return this.db
      .query<Raw, [string]>(
        "select * from repos where project_id = ? order by name",
      )
      .all(projectId)
      .map(row);
  }

  count(projectId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "select count(*) as n from repos where project_id = ?",
      )
      .get(projectId)!.n;
  }

  nameTaken(projectId: string, name: string, exceptId?: string): boolean {
    return (
      this.db
        .query<{ id: string }, [string, string]>(
          "select id from repos where project_id = ? and name = ?",
        )
        .all(projectId, name)
        .filter((found) => found.id !== exceptId).length > 0
    );
  }

  // the repositories that name a credential, as project id and name
  usingCredential(credentialId: string): { projectId: string; name: string }[] {
    return this.db
      .query<{ project_id: string; name: string }, [string]>(
        `select project_id, name from repos where credential_id = ?
         order by project_id, name`,
      )
      .all(credentialId)
      .map((found) => ({ projectId: found.project_id, name: found.name }));
  }

  create(projectId: string, fields: RepoFields, now: number): RepoRow {
    const id = newId();
    this.db
      .query(
        `insert into repos (id, project_id, name, url, kind, ref,
           credential_id, ignore_rules, state, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        projectId,
        fields.name,
        fields.url,
        fields.kind,
        fields.ref,
        fields.credentialId,
        fields.ignore,
        now,
        now,
      );
    return this.byId(id)!;
  }

  // a change to what is fetched sets it pending and clears what the last
  // fetch found, which no longer describes the row
  update(
    id: string,
    fields: RepoFields,
    refetch: boolean,
    now: number,
  ): RepoRow | null {
    this.db
      .query(
        `update repos set name = ?, url = ?, kind = ?, ref = ?,
           credential_id = ?, ignore_rules = ?, updated_at = ?,
           state = case when ? then 'pending' else state end,
           error = case when ? then null else error end,
           etag = case when ? then null else etag end,
           commit_id = case when ? then null else commit_id end,
           fetched_at = case when ? then null else fetched_at end,
           files = case when ? then null else files end,
           bytes = case when ? then null else bytes end,
           ignored = case when ? then null else ignored end
         where id = ?`,
      )
      .run(
        fields.name,
        fields.url,
        fields.kind,
        fields.ref,
        fields.credentialId,
        fields.ignore,
        now,
        ...Array<number>(8).fill(refetch ? 1 : 0),
        id,
      );
    return this.byId(id);
  }

  // a refresh asked for: the next turn or the fetch picks it up
  markPending(id: string, now: number): RepoRow | null {
    this.db
      .query(
        "update repos set state = 'pending', error = null, updated_at = ? where id = ?",
      )
      .run(now, id);
    return this.byId(id);
  }

  // what a lookup or a fetch found; the fields left out keep their value
  setFetched(id: string, fetched: RepoFetched): void {
    const has = (key: keyof RepoFetched) => Object.hasOwn(fetched, key);
    this.db
      .query(
        `update repos set state = ?, error = ?,
           etag = case when ? then ? else etag end,
           commit_id = case when ? then ? else commit_id end,
           fetched_at = case when ? then ? else fetched_at end,
           files = case when ? then ? else files end,
           bytes = case when ? then ? else bytes end,
           ignored = case when ? then ? else ignored end
         where id = ?`,
      )
      .run(
        fetched.state,
        fetched.error,
        has("etag") ? 1 : 0,
        fetched.etag ?? null,
        has("commit") ? 1 : 0,
        fetched.commit ?? null,
        has("fetchedAt") ? 1 : 0,
        fetched.fetchedAt ?? null,
        has("files") ? 1 : 0,
        fetched.files ?? null,
        has("bytes") ? 1 : 0,
        fetched.bytes ?? null,
        has("ignored") ? 1 : 0,
        fetched.ignored ?? null,
        id,
      );
  }

  // at startup: a fetch the process was running when it stopped
  resetFetching(): number {
    return this.db
      .query("update repos set state = 'pending' where state = 'fetching'")
      .run().changes;
  }

  delete(id: string): boolean {
    return this.db.query("delete from repos where id = ?").run(id).changes > 0;
  }
}
