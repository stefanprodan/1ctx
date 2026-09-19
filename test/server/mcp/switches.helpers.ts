// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { McpServerStore } from "../../../src/server/mcp/index.ts";
import type { AgentServer } from "../../../src/shared/contracts/mcp.ts";

export function seedServer(store: McpServerStore, name: string, toolCount = 1) {
  const inputSchema = {
    type: "object",
    properties: {
      query: { type: "string", description: "detail ".repeat(130) },
    },
  };
  return store.create(
    {
      name,
      url: `https://${name}.test/mcp`,
      keyName: null,
      read: true,
      write: false,
      instructionsOn: true,
      timeoutMs: null,
      readPatterns: ["get_*"],
      writePatterns: [],
      excludedPatterns: [],
    },
    {
      serverName: name,
      serverVersion: "1",
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      instructions: `Use the ${name} server carefully.`,
      fingerprint: name,
      checkedAt: 1,
      tools: Array.from({ length: toolCount }, (_, index) => ({
        name: `get_item${index}`,
        description: "Read an item.",
        inputSchema,
        schemaJson: JSON.stringify(inputSchema),
        unusable: null,
      })),
    },
  );
}

export const link = (server: { id: string }): AgentServer => ({
  serverId: server.id,
  read: true,
  write: false,
});
