// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { DiscoveryResult } from "../../../src/server/mcp/discover.ts";
import { McpServerStore, summary } from "../../../src/server/mcp/store.ts";
import type { CreateMcpRequest } from "../../../src/shared/api/mcp.ts";
import { memoryDb } from "../../helpers/db.ts";

const fields = (): CreateMcpRequest => ({
  name: "cluster",
  url: "https://store.test/mcp",
  keyName: null,
  read: true,
  write: false,
  instructionsOn: true,
  timeoutMs: null,
  readPatterns: ["get_*"],
  writePatterns: [],
  excludedPatterns: [],
});

const found = (at = 100): DiscoveryResult => ({
  serverName: "server",
  serverVersion: "1.0.0",
  protocolEra: "modern",
  protocolVersion: "2026-07-28",
  instructions: "Use the tools.",
  fingerprint: `fingerprint-${at}`,
  checkedAt: at,
  tools: [
    {
      name: "get_status",
      description: "Get status.",
      inputSchema: { type: "object", properties: {} },
      schemaJson: '{"type":"object","properties":{}}',
      unusable: null,
    },
  ],
});

describe("MCP server store", () => {
  test("keeps settings changed during discovery", () => {
    const db = memoryDb();
    const store = new McpServerStore(db);
    const row = store.create(fields(), found());
    store.updateSettings(row.id, {
      read: false,
      write: true,
      readPatterns: ["read_*"],
    });
    const applied = store.applyDiscovery(row.id, found(200))!;
    expect(applied.read).toBeFalse();
    expect(applied.write).toBeTrue();
    expect(applied.readPatterns).toEqual(["read_*"]);
    expect(applied.checkedAt).toBe(200);
    db.close();
  });

  test("records only meaningful discovery changes", () => {
    const db = memoryDb();
    const store = new McpServerStore(db);
    const row = store.create(fields(), found());
    expect(store.applyDiscovery(row.id, found(200))!.lastChange).toBeNull();
    const changed = found(300);
    changed.tools[0] = {
      ...changed.tools[0],
      description: "New status.",
    };
    changed.tools.push({
      name: "apply",
      description: "Apply.",
      inputSchema: { type: "object", properties: {} },
      schemaJson: '{"type":"object","properties":{}}',
      unusable: null,
    });
    changed.instructions = "New instructions.";
    const applied = store.applyDiscovery(row.id, changed)!;
    expect(applied.lastChange).toEqual({
      at: 300,
      added: ["apply"],
      removed: [],
      changed: ["get_status"],
      instructions: true,
    });
    db.close();
  });

  test("clears refresh failure and moves only supplied endpoint fields", () => {
    const db = memoryDb();
    const store = new McpServerStore(db);
    const row = store.create({ ...fields(), keyName: "mcp-old" }, found());
    store.recordFailure(row.id, "failed", 150);
    const moved = store.applyDiscovery(row.id, found(200), {
      url: "https://moved.test/mcp/",
      keyName: null,
    })!;
    expect(moved.url).toBe("https://moved.test/mcp/");
    expect(moved.keyName).toBeNull();
    expect(moved.refreshError).toBeNull();
    expect(moved.refreshFailedAt).toBeNull();
    db.close();
  });

  test("recordFailure leaves the good tools untouched", () => {
    const db = memoryDb();
    const store = new McpServerStore(db);
    const row = store.create(fields(), found());
    store.recordFailure(row.id, "not now", 200);
    const failed = store.byId(row.id)!;
    expect(failed.refreshError).toBe("not now");
    expect(failed.refreshFailedAt).toBe(200);
    expect(failed.tools.map((tool) => tool.name)).toEqual(["get_status"]);
    db.close();
  });

  test("answers missing when discovery lands after deletion", () => {
    const db = memoryDb();
    const store = new McpServerStore(db);
    const row = store.create(fields(), found());
    expect(store.deleteUnreferenced(row.id)).toBe("deleted");
    expect(store.applyDiscovery(row.id, found(200))).toBeNull();
    db.close();
  });

  test("does not delete a server referenced by an agent", () => {
    const db = memoryDb();
    const store = new McpServerStore(db);
    const row = store.create(fields(), found());
    db.exec("pragma foreign_keys = off");
    db.query(
      `insert into agent_servers (agent_id, server_id, read, write)
       values (?, ?, 1, 0)`,
    ).run("agent-test", row.id);
    db.exec("pragma foreign_keys = on");
    expect(store.deleteUnreferenced(row.id)).toBe("referenced");
    expect(store.byId(row.id)).not.toBeNull();
    db.close();
  });

  test("finds only rows older than the stale boundary", () => {
    const db = memoryDb();
    const store = new McpServerStore(db);
    store.create(fields(), found(100));
    store.create({ ...fields(), name: "second" }, found(200));
    expect(store.stale(200).map((row) => row.name)).toEqual(["cluster"]);
    db.close();
  });

  test("renders summary parameters and reports key presence", () => {
    const db = memoryDb();
    const store = new McpServerStore(db);
    const row = store.create(
      { ...fields(), keyName: "mcp-hands-key" },
      found(),
    );
    let markdown = "";
    const value = summary(
      row,
      (name) => name === "mcp-hands-key",
      (text) => {
        markdown = text;
        return "<pre>parameters</pre>";
      },
    );
    expect(value.hasKey).toBeTrue();
    expect(value.tools[0].wireName).toBe("mcp__cluster__get_status");
    expect(value.tools[0].parameters).toEqual({
      type: "object",
      properties: {},
    });
    expect(value.tools[0].parametersHtml).toBe("<pre>parameters</pre>");
    expect(markdown).toContain('"properties": {}');
    db.close();
  });
});
