// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateMcpRequest,
  McpProjects,
  PatchMcpSettings,
} from "../../shared/api/mcp.ts";
import type {
  McpChange,
  McpScope,
  McpSide,
} from "../../shared/contracts/mcp.ts";
import { type Db, parseStored, transact } from "../db/index.ts";
import { Conflict } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { DiscoveredTool, DiscoveryResult } from "./discover.ts";
import {
  addLink,
  allProjectIds,
  choicesOf,
  type ProjectChoices,
  projectIdsOf,
  removeLink,
  writeChoice,
  writeScope,
} from "./scope.ts";

export type McpToolRow = {
  serverId: string;
  name: string;
  description: string;
  inputSchema: string;
  unusable: string | null;
};

export type McpServerRow = {
  id: string;
  name: string;
  url: string;
  keyName: string | null;
  read: boolean;
  write: boolean;
  instructionsOn: boolean;
  timeoutMs: number | null;
  readPatterns: string[];
  writePatterns: string[];
  excludedPatterns: string[];
  scope: McpScope;
  // the team projects a list holds, by id; empty for all
  projectIds: string[];
  personal: McpSide;
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  instructions: string;
  fingerprint: string;
  checkedAt: number;
  lastChange: McpChange | null;
  refreshError: string | null;
  refreshFailedAt: number | null;
  createdAt: number;
  tools: McpToolRow[];
};

type RawServer = {
  id: string;
  name: string;
  url: string;
  key_name: string | null;
  read: number;
  write: number;
  instructions_on: number;
  timeout_ms: number | null;
  read_patterns: string;
  write_patterns: string;
  excluded_patterns: string;
  scope: McpScope;
  personal: McpSide;
  server_name: string;
  server_version: string;
  protocol_version: string;
  instructions: string;
  fingerprint: string;
  checked_at: number;
  last_change: string | null;
  refresh_error: string | null;
  refresh_failed_at: number | null;
  created_at: number;
};

// a server's endpoint, grants and switches, without its tools
export type McpScopeRow = Pick<
  McpServerRow,
  | "id"
  | "name"
  | "url"
  | "keyName"
  | "scope"
  | "projectIds"
  | "personal"
  | "read"
  | "write"
>;

type RawTool = {
  server_id: string;
  name: string;
  description: string;
  input_schema: string;
  unusable: string | null;
};

function toolRow(raw: RawTool): McpToolRow {
  return {
    serverId: raw.server_id,
    name: raw.name,
    description: raw.description,
    inputSchema: raw.input_schema,
    unusable: raw.unusable,
  };
}

function row(
  raw: RawServer,
  tools: McpToolRow[],
  projectIds: string[],
): McpServerRow {
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url,
    keyName: raw.key_name,
    read: raw.read === 1,
    write: raw.write === 1,
    instructionsOn: raw.instructions_on === 1,
    timeoutMs: raw.timeout_ms,
    readPatterns: parseStored(raw.read_patterns, []),
    writePatterns: parseStored(raw.write_patterns, []),
    excludedPatterns: parseStored(raw.excluded_patterns, []),
    scope: raw.scope,
    projectIds: raw.scope === "all" ? [] : projectIds,
    personal: raw.personal,
    serverName: raw.server_name,
    serverVersion: raw.server_version,
    protocolVersion: raw.protocol_version,
    instructions: raw.instructions,
    fingerprint: raw.fingerprint,
    checkedAt: raw.checked_at,
    lastChange: parseStored(raw.last_change, null),
    refreshError: raw.refresh_error,
    refreshFailedAt: raw.refresh_failed_at,
    createdAt: raw.created_at,
    tools,
  };
}

export class McpServerStore {
  constructor(private readonly db: Db) {}

  private tools(serverId: string): McpToolRow[] {
    return this.db
      .query<RawTool, [string]>(
        "select * from mcp_tools where server_id = ? order by name",
      )
      .all(serverId)
      .map(toolRow);
  }

  // every server's tools in one query, each list by name
  private allTools(): Map<string, McpToolRow[]> {
    const out = new Map<string, McpToolRow[]>();
    const raws = this.db
      .query<RawTool, []>("select * from mcp_tools order by server_id, name")
      .all();
    for (const raw of raws) {
      const list = out.get(raw.server_id) ?? [];
      list.push(toolRow(raw));
      out.set(raw.server_id, list);
    }
    return out;
  }

  private full(raw: RawServer): McpServerRow {
    return row(raw, this.tools(raw.id), projectIdsOf(this.db, raw.id));
  }

  list(): McpServerRow[] {
    const tools = this.allTools();
    const projects = allProjectIds(this.db);
    return this.db
      .query<RawServer, []>("select * from mcp_servers order by name")
      .all()
      .map((raw) =>
        row(raw, tools.get(raw.id) ?? [], projects.get(raw.id) ?? []),
      );
  }

  // every server's endpoint and grants in name order, its tools unread
  scopes(): McpScopeRow[] {
    const projects = allProjectIds(this.db);
    type Raw = Pick<
      RawServer,
      | "id"
      | "name"
      | "url"
      | "key_name"
      | "scope"
      | "personal"
      | "read"
      | "write"
    >;
    return this.db
      .query<Raw, []>(
        `select id, name, url, key_name, scope, personal, read, write
         from mcp_servers order by name`,
      )
      .all()
      .map((raw) => ({
        id: raw.id,
        name: raw.name,
        url: raw.url,
        keyName: raw.key_name,
        scope: raw.scope,
        projectIds: raw.scope === "all" ? [] : (projects.get(raw.id) ?? []),
        personal: raw.personal,
        read: raw.read === 1,
        write: raw.write === 1,
      }));
  }

  // the project's kind and its choices, null for a missing project
  choices(projectId: string): ProjectChoices | null {
    return choicesOf(this.db, projectId);
  }

  // read is the default, so it is held as no row
  setChoice(projectId: string, serverId: string, side: McpSide): void {
    writeChoice(this.db, projectId, serverId, side);
  }

  exists(id: string): boolean {
    return (
      this.db.query("select 1 from mcp_servers where id = ?").get(id) !== null
    );
  }

  byId(id: string): McpServerRow | null {
    const raw = this.db
      .query<RawServer, [string]>("select * from mcp_servers where id = ?")
      .get(id);
    return raw === null ? null : this.full(raw);
  }

  byName(name: string): McpServerRow | null {
    const raw = this.db
      .query<RawServer, [string]>("select * from mcp_servers where name = ?")
      .get(name);
    return raw === null ? null : this.full(raw);
  }

  private insertTools(serverId: string, tools: DiscoveredTool[]): void {
    const insert = this.db.query(
      `insert into mcp_tools
         (server_id, name, description, input_schema, unusable)
       values (?, ?, ?, ?, ?)`,
    );
    for (const tool of tools) {
      insert.run(
        serverId,
        tool.name,
        tool.description,
        tool.schemaJson,
        tool.unusable,
      );
    }
  }

  create(fields: CreateMcpRequest, found: DiscoveryResult): McpServerRow {
    return transact(this.db, () => {
      if (this.byName(fields.name) !== null) {
        throw new Conflict(`a server named ${fields.name} exists`);
      }
      const id = newId();
      this.db
        .query(
          `insert into mcp_servers
             (id, name, url, key_name, read, write, instructions_on,
              timeout_ms, read_patterns, write_patterns, excluded_patterns,
              server_name, server_version, protocol_version, instructions,
              fingerprint, checked_at, last_change, refresh_error,
              refresh_failed_at, created_at, personal)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null,
                   null, null, ?, ?)`,
        )
        .run(
          id,
          fields.name,
          fields.url,
          fields.keyName,
          fields.read ? 1 : 0,
          fields.write ? 1 : 0,
          fields.instructionsOn ? 1 : 0,
          fields.timeoutMs,
          JSON.stringify(fields.readPatterns),
          JSON.stringify(fields.writePatterns),
          JSON.stringify(fields.excludedPatterns),
          found.serverName,
          found.serverVersion,
          found.protocolVersion,
          found.instructions,
          found.fingerprint,
          found.checkedAt,
          found.checkedAt,
          fields.personal ?? "read",
        );
      this.insertTools(id, found.tools);
      this.setScope(id, fields.projects ?? "all");
      return { result: this.byId(id)! };
    });
  }

  updateSettings(id: string, change: PatchMcpSettings): McpServerRow | null {
    const columns: string[] = [];
    const values: (string | number | null)[] = [];
    const add = (column: string, value: string | number | null) => {
      columns.push(`${column} = ?`);
      values.push(value);
    };
    if (change.read !== undefined) add("read", change.read ? 1 : 0);
    if (change.write !== undefined) add("write", change.write ? 1 : 0);
    if (change.instructionsOn !== undefined) {
      add("instructions_on", change.instructionsOn ? 1 : 0);
    }
    if ("timeoutMs" in change) add("timeout_ms", change.timeoutMs ?? null);
    if (change.readPatterns !== undefined) {
      add("read_patterns", JSON.stringify(change.readPatterns));
    }
    if (change.writePatterns !== undefined) {
      add("write_patterns", JSON.stringify(change.writePatterns));
    }
    if (change.excludedPatterns !== undefined) {
      add("excluded_patterns", JSON.stringify(change.excludedPatterns));
    }
    if (columns.length > 0) {
      this.db
        .query(`update mcp_servers set ${columns.join(", ")} where id = ?`)
        .run(...values, id);
    }
    return this.byId(id);
  }

  private change(
    before: McpServerRow,
    found: DiscoveryResult,
  ): McpChange | null {
    const old = new Map(before.tools.map((tool) => [tool.name, tool]));
    const next = new Map(found.tools.map((tool) => [tool.name, tool]));
    const added = [...next.keys()].filter((name) => !old.has(name)).sort();
    const removed = [...old.keys()].filter((name) => !next.has(name)).sort();
    const changed = [...next.entries()]
      .filter(([name, tool]) => {
        const prior = old.get(name);
        return (
          prior !== undefined &&
          (prior.description !== tool.description ||
            prior.inputSchema !== tool.schemaJson ||
            prior.unusable !== tool.unusable)
        );
      })
      .map(([name]) => name)
      .sort();
    const instructions = before.instructions !== found.instructions;
    if (
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      !instructions
    ) {
      return null;
    }
    return { at: found.checkedAt, added, removed, changed, instructions };
  }

  applyDiscovery(
    id: string,
    found: DiscoveryResult,
    moved?: { url?: string; keyName?: string | null },
  ): McpServerRow | null {
    return transact(this.db, () => {
      const before = this.byId(id);
      if (before === null) return { result: null };
      const change = this.change(before, found);
      const columns = [
        "server_name = ?",
        "server_version = ?",
        "protocol_version = ?",
        "instructions = ?",
        "fingerprint = ?",
        "checked_at = ?",
        "refresh_error = null",
        "refresh_failed_at = null",
      ];
      const values: (string | number | null)[] = [
        found.serverName,
        found.serverVersion,
        found.protocolVersion,
        found.instructions,
        found.fingerprint,
        found.checkedAt,
      ];
      if (change !== null) {
        columns.push("last_change = ?");
        values.push(JSON.stringify(change));
      }
      if (moved?.url !== undefined) {
        columns.push("url = ?");
        values.push(moved.url);
      }
      if (moved && "keyName" in moved) {
        columns.push("key_name = ?");
        values.push(moved.keyName ?? null);
      }
      this.db
        .query(`update mcp_servers set ${columns.join(", ")} where id = ?`)
        .run(...values, id);
      this.db.query("delete from mcp_tools where server_id = ?").run(id);
      this.insertTools(id, found.tools);
      return { result: this.byId(id) };
    });
  }

  // the whole scope, replacing what was held; ids are checked team
  // projects
  setScope(id: string, projects: McpProjects): void {
    writeScope(this.db, id, projects);
  }

  setPersonal(id: string, side: McpSide): void {
    this.db
      .query("update mcp_servers set personal = ? where id = ?")
      .run(side, id);
  }

  // one project onto a list, or off it; false when nothing moved
  addProject(id: string, projectId: string): boolean {
    return addLink(this.db, id, projectId);
  }

  removeProject(id: string, projectId: string): boolean {
    return removeLink(this.db, id, projectId);
  }

  recordFailure(id: string, error: string, now: number): void {
    this.db
      .query(
        `update mcp_servers set refresh_error = ?, refresh_failed_at = ?
         where id = ?`,
      )
      .run(error, now, id);
  }

  // its grants and choices go with it
  delete(id: string): boolean {
    return (
      this.db.query("delete from mcp_servers where id = ?").run(id).changes > 0
    );
  }

  stale(before: number): McpServerRow[] {
    return this.db
      .query<RawServer, [number]>(
        `select * from mcp_servers where checked_at < ?
         order by checked_at, name`,
      )
      .all(before)
      .map((raw) => this.full(raw));
  }
}
