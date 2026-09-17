// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SearchProvider, WebTool } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";

export type ToolRow = {
  name: WebTool;
  enabled: boolean;
  provider: SearchProvider | null;
  hosts: string[];
  updatedAt: number;
};

type Raw = {
  name: WebTool;
  enabled: number;
  provider: SearchProvider | null;
  hosts: string;
  updated_at: number;
};

const row = (raw: Raw): ToolRow => ({
  name: raw.name,
  enabled: raw.enabled === 1,
  provider: raw.provider,
  hosts: JSON.parse(raw.hosts),
  updatedAt: raw.updated_at,
});

export class ToolStore {
  constructor(private readonly db: Db) {}

  rows(): ToolRow[] {
    return this.db
      .query<Raw, []>(
        `select name, enabled, provider, hosts, updated_at from tools
         order by rowid`,
      )
      .all()
      .map(row);
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
