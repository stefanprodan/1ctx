// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../../../src/server/db/index.ts";
import type { McpServerStore } from "../../../src/server/mcp/index.ts";

// a project and its owner, for an offer that needs a real project
export function seedProject(db: Db, id: string, kind = "team") {
  const owner = `owner-${id}`;
  db.query(
    `insert into users (id, username, full_name, email, role, password_hash, created_at)
     values (?, ?, 'Owner', ?, 'member', 'x', 0)`,
  ).run(owner, owner, `${owner}@example.com`);
  db.query(
    `insert into projects (id, kind, name, owner_id, created_at)
     values (?, ?, ?, ?, 0)`,
  ).run(id, kind, kind === "personal" ? "personal" : id, owner);
}

// write adds a set_ tool on the write side and turns the Write switch on
export function seedServer(
  store: McpServerStore,
  name: string,
  toolCount = 1,
  write = false,
) {
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
      write,
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
      tools: [
        ...Array.from({ length: toolCount }, (_, index) => ({
          name: `get_item${index}`,
          description: "Read an item.",
          inputSchema,
          schemaJson: JSON.stringify(inputSchema),
          unusable: null,
        })),
        ...(write
          ? [
              {
                name: "set_item",
                description: "Change an item.",
                inputSchema,
                schemaJson: JSON.stringify(inputSchema),
                unusable: null,
              },
            ]
          : []),
      ],
    },
  );
}

// an area built alone: no project is known and no route is called
export const NO_PROJECTS = {
  projects: { byId: () => null, personal: () => null },
  access: {
    project: (): never => {
      throw new Error("no projects");
    },
  },
};
