// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { WebAccessMode } from "../../shared/web.ts";
import type { SearchProvider, WebTool } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";

export type ToolRow = {
  name: WebTool | "web";
  enabled: boolean;
  provider: SearchProvider | null;
  hosts: string[];
  mode: WebAccessMode | null;
  updatedAt: number;
};

type Raw = {
  name: WebTool | "web";
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

  setEnabled(name: WebTool, enabled: boolean, now: number): void {
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
