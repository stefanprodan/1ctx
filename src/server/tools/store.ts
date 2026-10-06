// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { WebAccessMode } from "../../shared/web.ts";
import type {
  EMAIL_TOOL,
  SearchProvider,
  WebTool,
} from "../../shared/words.ts";
import type { Db } from "../db/index.ts";

// a row per web tool, the web's own and email_user's
type RowName = WebTool | "web" | typeof EMAIL_TOOL;

export type ToolRow = {
  name: RowName;
  enabled: boolean;
  provider: SearchProvider | null;
  hosts: string[];
  mode: WebAccessMode | null;
  updatedAt: number;
};

type Raw = {
  name: RowName;
  enabled: number;
  provider: SearchProvider | null;
  hosts: string;
  mode: WebAccessMode | null;
  updated_at: number;
};

const row = (raw: Raw): ToolRow => ({
  name: raw.name,
  enabled: raw.enabled === 1,
  provider: raw.provider,
  hosts: JSON.parse(raw.hosts),
  mode: raw.mode,
  updatedAt: raw.updated_at,
});

export class ToolStore {
  constructor(private readonly db: Db) {}

  rows(): ToolRow[] {
    return this.db
      .query<Raw, []>(
        `select name, enabled, provider, hosts, mode, updated_at from tools
         order by rowid`,
      )
      .all()
      .map(row);
  }

  // every name has a row from the migrations on
  row(name: ToolRow["name"]): ToolRow {
    const raw = this.db
      .query<Raw, [string]>(
        `select name, enabled, provider, hosts, mode, updated_at from tools
         where name = ?`,
      )
      .get(name);
    if (raw === null) throw new Error(`no tools row for ${name}`);
    return row(raw);
  }

  setAccess(
    mode: WebAccessMode,
    domains: readonly string[],
    now: number,
  ): void {
    this.db
      .query(
        "update tools set mode = ?, hosts = ?, updated_at = ? where name = 'web'",
      )
      .run(mode, JSON.stringify(domains), now);
  }

  setEnabled(
    name: WebTool | typeof EMAIL_TOOL,
    enabled: boolean,
    now: number,
  ): void {
    this.db
      .query("update tools set enabled = ?, updated_at = ? where name = ?")
      .run(enabled ? 1 : 0, now, name);
  }

  setProvider(provider: SearchProvider | null, now: number): void {
    this.db
      .query(
        "update tools set provider = ?, updated_at = ? where name = 'websearch'",
      )
      .run(provider, now);
  }

  setHosts(hosts: readonly string[], now: number): void {
    this.db
      .query(
        "update tools set hosts = ?, updated_at = ? where name = 'visualize'",
      )
      .run(JSON.stringify(hosts), now);
  }
}
