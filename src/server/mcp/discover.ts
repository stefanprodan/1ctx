// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { cutCodePoints } from "../../shared/text.ts";
import { bytesWords } from "../lib/bytes.ts";
import { sha256 } from "../lib/ids.ts";
import type { Fetcher } from "../providers/index.ts";
import {
  type ClientInfo,
  type ListedTool,
  scrub,
  withClient,
} from "./client.ts";
import {
  DISCOVERY_BODY_BYTES,
  DISCOVERY_TIMEOUT_MS,
  MAX_INSTRUCTIONS,
  MAX_REPORTED_SERVER_NAME,
  MAX_SERVER_VERSION,
  MAX_TOOL_DESCRIPTION,
  MAX_TOOL_SCHEMA_BYTES,
  MAX_TOOLS,
  MAX_TOOLS_BYTES,
} from "./limits.ts";

export type DiscoveredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schemaJson: string;
  unusable: string | null;
};

export type DiscoveryResult = {
  serverName: string;
  serverVersion: string;
  protocolEra: "modern" | "legacy" | "";
  protocolVersion: string;
  instructions: string;
  fingerprint: string;
  checkedAt: number;
  tools: DiscoveredTool[];
};

export function fingerprint(fields: {
  serverName: string;
  serverVersion: string;
  instructions: string;
}): string {
  return sha256(
    JSON.stringify([
      fields.serverName,
      fields.serverVersion,
      fields.instructions,
    ]),
  );
}

function schemaOf(tool: ListedTool): {
  inputSchema: Record<string, unknown>;
  schemaJson: string;
  size: number;
  unusable: string | null;
} {
  const inputSchema = { ...tool.inputSchema };
  if (inputSchema.properties === undefined) inputSchema.properties = {};
  const schemaJson = JSON.stringify(inputSchema);
  const size = Buffer.byteLength(schemaJson);
  if (size <= MAX_TOOL_SCHEMA_BYTES) {
    return { inputSchema, schemaJson, size, unusable: null };
  }
  const replacement = { type: "object", properties: {} };
  return {
    inputSchema: replacement,
    schemaJson: JSON.stringify(replacement),
    size,
    unusable: `input schema is over ${bytesWords(MAX_TOOL_SCHEMA_BYTES)}`,
  };
}

// the server's identity as stored, scrubbed and cut, with its
// fingerprint, so a call compares what discovery kept
export function identityOf(info: ClientInfo, key: string | null) {
  const raw = scrub(info, key);
  const identity = {
    serverName: cutCodePoints(raw.serverName, MAX_REPORTED_SERVER_NAME),
    serverVersion: cutCodePoints(raw.serverVersion, MAX_SERVER_VERSION),
    instructions: cutCodePoints(raw.instructions.trim(), MAX_INSTRUCTIONS),
  };
  return {
    ...identity,
    protocolEra: raw.protocolEra,
    protocolVersion: raw.protocolVersion,
    fingerprint: fingerprint(identity),
  };
}

export async function discover(
  deps: {
    fetcher: Fetcher;
    version: string;
    clock: () => number;
  },
  endpoint: { url: string },
  key: string | null,
  signal = new AbortController().signal,
): Promise<DiscoveryResult> {
  return withClient(
    deps,
    endpoint,
    key,
    {
      signal,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      bodyBytes: DISCOVERY_BODY_BYTES,
    },
    async (client) => {
      const listed = scrub(await client.listTools(), key);
      if (listed.tools.length > MAX_TOOLS) {
        throw new Error(`the server listed more than ${MAX_TOOLS} tools`);
      }
      const tools: DiscoveredTool[] = [];
      const seen = new Set<string>();
      let total = 0;
      for (const tool of listed.tools) {
        if (seen.has(tool.name)) {
          throw new Error(`the server listed ${tool.name} twice`);
        }
        seen.add(tool.name);
        const schema = schemaOf(tool);
        const description = cutCodePoints(
          typeof tool.description === "string" ? tool.description : "",
          MAX_TOOL_DESCRIPTION,
        );
        total +=
          Buffer.byteLength(tool.name) +
          Buffer.byteLength(description) +
          schema.size;
        if (total > MAX_TOOLS_BYTES) {
          throw new Error(
            `the server's tools are over ${bytesWords(MAX_TOOLS_BYTES)}`,
          );
        }
        tools.push({
          name: tool.name,
          description,
          inputSchema: schema.inputSchema,
          schemaJson: schema.schemaJson,
          unusable: schema.unusable,
        });
      }
      return {
        ...identityOf(client.info(), key),
        checkedAt: deps.clock(),
        tools,
      };
    },
  );
}
