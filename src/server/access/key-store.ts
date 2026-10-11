// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { CreateAccessKeyRequest } from "../../shared/api/profile.ts";
import {
  ACCESS_KEY_PREFIX,
  type AccessKey,
} from "../../shared/contracts/access-key.ts";
import type { Db } from "../db/index.ts";
import { DAY_MS, MINUTE_MS } from "../lib/clock.ts";
import { newId, newToken, sha256 } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";

export type AccessKeyRow = AccessKey & { userId: string };

type Raw = {
  id: string;
  user_id: string;
  name: string;
  scope: AccessKey["scope"];
  project_ids: string | null;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
};

const COLUMNS =
  "id, user_id, name, scope, project_ids, created_at, expires_at, last_used_at";

const row = (raw: Raw): AccessKeyRow => ({
  id: raw.id,
  userId: raw.user_id,
  name: raw.name,
  scope: raw.scope,
  projectIds: raw.project_ids === null ? null : JSON.parse(raw.project_ids),
  createdAt: raw.created_at,
  expiresAt: raw.expires_at,
  lastUsedAt: raw.last_used_at,
});

export const accessKeyOf = ({ userId: _, ...key }: AccessKeyRow): AccessKey =>
  key;

export function logRevokedKeys(
  log: Log,
  user: string,
  keys: readonly AccessKeyRow[],
): void {
  for (const key of keys) {
    log.info("access key revoked", { user, key: key.id, scope: key.scope });
  }
}

export class AccessKeyStore {
  constructor(private readonly db: Db) {}

  create(
    userId: string,
    fields: CreateAccessKeyRequest,
    now: number,
  ): { key: AccessKeyRow; token: string } {
    const id = newId();
    const token = ACCESS_KEY_PREFIX + newToken();
    this.db
      .query(
        `insert into access_keys
         (id, user_id, name, token_hash, scope, project_ids, created_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        fields.name,
        sha256(token),
        fields.scope,
        fields.projectIds === null ? null : JSON.stringify(fields.projectIds),
        now,
        now + fields.days * DAY_MS,
      );
    return { key: this.byId(id)!, token };
  }

  byId(id: string): AccessKeyRow | null {
    const raw = this.db
      .query<Raw, [string]>(`select ${COLUMNS} from access_keys where id = ?`)
      .get(id);
    return raw === null ? null : row(raw);
  }

  byTokenHash(hash: string): AccessKeyRow | null {
    const raw = this.db
      .query<Raw, [string]>(
        `select ${COLUMNS} from access_keys where token_hash = ?`,
      )
      .get(hash);
    return raw === null ? null : row(raw);
  }

  list(userId: string): AccessKeyRow[] {
    return this.db
      .query<Raw, [string]>(
        `select ${COLUMNS} from access_keys where user_id = ?
         order by created_at desc, rowid desc`,
      )
      .all(userId)
      .map(row);
  }

  touch(id: string, now: number): void {
    this.db
      .query(
        `update access_keys set last_used_at = ? where id = ?
         and (last_used_at is null or last_used_at <= ?)`,
      )
      .run(now, id, now - MINUTE_MS);
  }

  delete(userId: string, id: string): AccessKeyRow | null {
    const raw = this.db
      .query<Raw, [string, string]>(
        `delete from access_keys where user_id = ? and id = ?
         returning ${COLUMNS}`,
      )
      .get(userId, id);
    return raw === null ? null : row(raw);
  }

  deleteForUser(userId: string): AccessKeyRow[] {
    return this.db
      .query<Raw, [string]>(
        `delete from access_keys where user_id = ? returning ${COLUMNS}`,
      )
      .all(userId)
      .map(row);
  }
}
