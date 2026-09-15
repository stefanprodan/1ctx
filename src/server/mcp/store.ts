// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateMcpRequest,
  PatchMcpSettings,
} from "../../shared/api/mcp.ts";
import type {
  AgentServer,
  McpChange,
  McpServerSummary,
  McpToolSummary,
} from "../../shared/contracts/mcp.ts";
import { wireName } from "../../shared/mcp.ts";
import { type Db, transact } from "../db/index.ts";
import { BadRequest, Conflict } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { DiscoveredTool, DiscoveryResult } from "./discover.ts";

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

type RawTool = {
  server_id: string;
  name: string;
  description: string;
  input_schema: string;
  unusable: string | null;
};

type RawAgentServer = {
  server_id: string;
  read: number;
  write: number;
};

function parsed<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toolRow(raw: RawTool): McpToolRow {
  return {
    serverId: raw.server_id,
    name: raw.name,
    description: raw.description,
    inputSchema: raw.input_schema,
    unusable: raw.unusable,
  };
}

function row(raw: RawServer, tools: McpToolRow[]): McpServerRow {
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url,
    keyName: raw.key_name,
    read: raw.read === 1,
    write: raw.write === 1,
    instructionsOn: raw.instructions_on === 1,
    timeoutMs: raw.timeout_ms,
    readPatterns: parsed(raw.read_patterns, []),
    writePatterns: parsed(raw.write_patterns, []),
    excludedPatterns: parsed(raw.excluded_patterns, []),
    serverName: raw.server_name,
    serverVersion: raw.server_version,
    protocolVersion: raw.protocol_version,
    instructions: raw.instructions,
    fingerprint: raw.fingerprint,
    checkedAt: raw.checked_at,
    lastChange: parsed(raw.last_change, null),
    refreshError: raw.refresh_error,
    refreshFailedAt: raw.refresh_failed_at,
    createdAt: raw.created_at,
    tools,
  };
}

function codeFence(json: string): string {
  const longest = Math.max(
    0,
    ...Array.from(json.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}json\n${json}\n${fence}`;
}

export function summary(
  server: McpServerRow,
  hasSecret: (name: string) => boolean,
  render: (markdown: string, streaming?: boolean) => string,
): McpServerSummary {
  const tools: McpToolSummary[] = server.tools.map((tool) => {
    const name = wireName(server.name, tool.name);
    let value: unknown = {};
    try {
      value = JSON.parse(tool.inputSchema);
    } catch {
      value = {};
    }
    const json = JSON.stringify(value, null, 2);
    return {
      name: tool.name,
      wireName: name,
      unusable: tool.unusable ?? (name === null ? "unusable name" : null),
      description: tool.description,
      parameters: value as object,
      schemaJson: tool.inputSchema,
      parametersHtml: render(codeFence(json), false),
    };
  });
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    keyName: server.keyName,
    hasKey: server.keyName !== null && hasSecret(server.keyName),
    read: server.read,
    write: server.write,
    instructionsOn: server.instructionsOn,
    timeoutMs: server.timeoutMs,
    readPatterns: server.readPatterns,
    writePatterns: server.writePatterns,
    excludedPatterns: server.excludedPatterns,
    serverName: server.serverName,
    serverVersion: server.serverVersion,
    protocolVersion: server.protocolVersion,
    instructions: server.instructions,
    checkedAt: server.checkedAt,
    lastChange: server.lastChange,
    refreshError: server.refreshError,
    refreshFailedAt: server.refreshFailedAt,
    createdAt: server.createdAt,
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

  list(): McpServerRow[] {
    return this.db
      .query<RawServer, []>("select * from mcp_servers order by name")
      .all()
      .map((raw) => row(raw, this.tools(raw.id)));
  }

  byId(id: string): McpServerRow | null {
    const raw = this.db
      .query<RawServer, [string]>("select * from mcp_servers where id = ?")
      .get(id);
    return raw === null ? null : row(raw, this.tools(raw.id));
  }

  byName(name: string): McpServerRow | null {
    const raw = this.db
      .query<RawServer, [string]>("select * from mcp_servers where name = ?")
      .get(name);
    return raw === null ? null : row(raw, this.tools(raw.id));
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
              refresh_failed_at, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null,
                   null, null, ?)`,
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
        );
      this.insertTools(id, found.tools);
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

  recordFailure(id: string, error: string, now: number): void {
    this.db
      .query(
        `update mcp_servers set refresh_error = ?, refresh_failed_at = ?
         where id = ?`,
      )
      .run(error, now, id);
  }

  deleteUnreferenced(id: string): "deleted" | "referenced" | "missing" {
    return transact(this.db, () => {
      if (this.byId(id) === null) return { result: "missing" as const };
      const references = this.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from agent_servers where server_id = ?",
        )
        .get(id)!.n;
      if (references > 0) return { result: "referenced" as const };
      this.db.query("delete from mcp_servers where id = ?").run(id);
      return { result: "deleted" as const };
    });
  }

  stale(before: number): McpServerRow[] {
    return this.db
      .query<RawServer, [number]>(
        `select * from mcp_servers where checked_at < ?
         order by checked_at, name`,
      )
      .all(before)
      .map((raw) => row(raw, this.tools(raw.id)));
  }

  agentServers(agentId: string): AgentServer[] {
    return this.db
      .query<RawAgentServer, [string]>(
        `select server_id, read, write from agent_servers
         where agent_id = ? order by server_id`,
      )
      .all(agentId)
      .map((link) => ({
        serverId: link.server_id,
        read: link.read === 1,
        write: link.write === 1,
      }));
  }

  setAgentServers(agentId: string, links: AgentServer[]): void {
    const seen = new Set<string>();
    for (const link of links) {
      if (seen.has(link.serverId)) {
        throw new BadRequest("serverId must not repeat");
      }
      if (!link.read && !link.write) {
        throw new BadRequest("a server needs read or write");
      }
      if (this.byId(link.serverId) === null) {
        throw new BadRequest("serverId is unknown");
      }
      seen.add(link.serverId);
    }
    this.db.query("delete from agent_servers where agent_id = ?").run(agentId);
    const insert = this.db.query(
      `insert into agent_servers (agent_id, server_id, read, write)
       values (?, ?, ?, ?)`,
    );
    for (const link of links) {
      insert.run(agentId, link.serverId, link.read ? 1 : 0, link.write ? 1 : 0);
    }
  }
}
