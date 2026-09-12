// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ProviderSummary } from "../../shared/contracts/provider.ts";
import type { Wire } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export type ProviderRow = {
  id: string;
  name: string;
  wire: Wire;
  baseUrl: string;
  keyName: string | null;
  createdAt: number;
};

type Raw = {
  id: string;
  name: string;
  wire: Wire;
  base_url: string;
  key_name: string | null;
  created_at: number;
};

const row = (raw: Raw): ProviderRow => ({
  id: raw.id,
  name: raw.name,
  wire: raw.wire,
  baseUrl: raw.base_url,
  keyName: raw.key_name,
  createdAt: raw.created_at,
});

// the row as the wire shows it: whether the key file is there, never
// what it holds
export const summary = (
  provider: ProviderRow,
  hasKey: boolean,
): ProviderSummary => ({
  id: provider.id,
  name: provider.name,
  wire: provider.wire,
  baseUrl: provider.baseUrl,
  keyName: provider.keyName,
  hasKey,
  createdAt: provider.createdAt,
});

export class ProviderStore {
  constructor(private readonly db: Db) {}

  list(): ProviderRow[] {
    return this.db
      .query<Raw, []>("select * from providers order by created_at, name")
      .all()
      .map(row);
  }

  byId(id: string): ProviderRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from providers where id = ?")
      .get(id);
    return raw ? row(raw) : null;
  }

  byName(name: string): ProviderRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from providers where name = ?")
      .get(name);
    return raw ? row(raw) : null;
  }

  create(fields: {
    name: string;
    wire: Wire;
    baseUrl: string;
    keyName: string | null;
    now: number;
  }): ProviderRow {
    const id = newId();
    this.db
      .query(
        "insert into providers (id, name, wire, base_url, key_name, created_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        fields.name,
        fields.wire,
        fields.baseUrl,
        fields.keyName,
        fields.now,
      );
    return this.byId(id)!;
  }

  delete(id: string): boolean {
    return (
      this.db.query("delete from providers where id = ?").run(id).changes > 0
    );
  }
}
