// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { discover } from "../../../src/server/mcp/discover.ts";
import { fixture, mcpFetch } from "./fake.ts";

const URL = "https://catalog.test/mcp";

async function run(
  mutateResult?: Parameters<typeof mcpFetch>[0]["mutateResult"],
  key: string | null = null,
) {
  const recorded = await fixture("flux-docs");
  const fake = mcpFetch({ recorded, mutateResult });
  const found = await discover(
    { fetcher: fake.fetcher, version: "test", clock: () => 42 },
    { url: URL },
    key,
  );
  return { found, fake };
}

describe("MCP discovery", () => {
  test("aggregates pages and fills missing properties", async () => {
    const { found, fake } = await run((method, result, body) => {
      if (method !== "tools/list") return result;
      const cursor = (body.params as { cursor?: string }).cursor;
      return cursor
        ? {
            ...result,
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
              },
            ],
          }
        : {
            ...result,
            tools: [
              {
                name: "first",
                inputSchema: { type: "object", properties: {} },
              },
            ],
            nextCursor: "page-2",
          };
    });
    expect(found.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(found.tools[1].inputSchema).toEqual({
      type: "object",
      properties: {},
    });
    expect(found.tools[1]).not.toHaveProperty("outputSchema");
    expect(
      fake.requests.filter((request) => request.method === "tools/list"),
    ).toHaveLength(2);
  });

  test("lets the SDK reject malformed tool schemas", async () => {
    await expect(
      run((method, result) =>
        method === "tools/list"
          ? {
              ...result,
              tools: [{ name: "bad", inputSchema: { type: "string" } }],
            }
          : result,
      ),
    ).rejects.toThrow();
  });

  test("refuses more than 500 tools", async () => {
    await expect(
      run((method, result) =>
        method === "tools/list"
          ? {
              ...result,
              tools: Array.from({ length: 501 }, (_, index) => ({
                name: `tool-${index}`,
                inputSchema: { type: "object", properties: {} },
              })),
            }
          : result,
      ),
    ).rejects.toThrow("more than 500 tools");
  });

  test("stores one oversized schema as unusable", async () => {
    const large = "x".repeat(65 * 1024);
    const { found } = await run((method, result) =>
      method === "tools/list"
        ? {
            ...result,
            tools: [
              {
                name: "large",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string", description: large } },
                },
              },
            ],
          }
        : result,
    );
    expect(found.tools[0].unusable).toBe("input schema is over 64 KB");
    expect(found.tools[0].schemaJson.length).toBeLessThan(1024);
  });

  test("refuses tool definitions over the server total", async () => {
    const large = "x".repeat(60 * 1024);
    await expect(
      run((method, result) =>
        method === "tools/list"
          ? {
              ...result,
              tools: Array.from({ length: 9 }, (_, index) => ({
                name: `large-${index}`,
                inputSchema: {
                  type: "object",
                  properties: {
                    value: { type: "string", description: large },
                  },
                },
              })),
            }
          : result,
      ),
    ).rejects.toThrow("over 512 KB");
  });

  test("cuts descriptions, instructions and server identity", async () => {
    const { found } = await run((method, result) => {
      if (method === "server/discover") {
        return {
          ...result,
          instructions: `  ${"i".repeat(20_000)}  `,
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "n".repeat(1_000),
              version: "v".repeat(1_000),
            },
          },
        };
      }
      if (method === "tools/list") {
        return {
          ...result,
          tools: [
            {
              name: "long",
              description: "d".repeat(10_000),
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      }
      return result;
    });
    expect(found.serverName).toHaveLength(200);
    expect(found.serverVersion).toHaveLength(100);
    expect(found.instructions).toHaveLength(16_000);
    expect(found.tools[0].description).toHaveLength(4_000);
    expect(found.checkedAt).toBe(42);
  });

  test("scrubs the key from every discovered string", async () => {
    const key = "private-token";
    const { found } = await run((method, result) => {
      if (method === "server/discover") {
        return {
          ...result,
          instructions: `use ${key}`,
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: `server-${key}`,
              version: key,
            },
          },
        };
      }
      if (method === "tools/list") {
        return {
          ...result,
          tools: [
            {
              name: `read-${key}`,
              description: key,
              inputSchema: {
                type: "object",
                properties: {
                  [key]: { type: "string", description: key },
                },
              },
            },
          ],
        };
      }
      return result;
    }, key);
    expect(JSON.stringify(found)).not.toContain(key);
    expect(JSON.stringify(found)).toContain("[redacted]");
  });

  test("allows an anonymous modern server", async () => {
    const { found } = await run((method, result) =>
      method === "server/discover"
        ? { ...result, instructions: undefined, _meta: {} }
        : result,
    );
    expect(found.serverName).toBe("");
    expect(found.serverVersion).toBe("");
    expect(found.instructions).toBe("");
    expect(found.protocolEra).toBe("modern");
  });
});

describe("MCP discovery pagination limit", () => {
  test("fails the 65th tools page without returning a partial list", async () => {
    const recorded = await fixture("flux-docs");
    const fake = mcpFetch({
      recorded,
      mutateResult(method, result, body) {
        if (method !== "tools/list") return result;
        const cursor = Number(
          (body.params as { cursor?: string }).cursor ?? "0",
        );
        return {
          ...result,
          tools: [
            {
              name: `page-${cursor}`,
              inputSchema: { type: "object", properties: {} },
            },
          ],
          nextCursor: String(cursor + 1),
        };
      },
    });
    await expect(
      discover(
        { fetcher: fake.fetcher, version: "test", clock: () => 42 },
        { url: URL },
        null,
      ),
    ).rejects.toThrow();
    expect(
      fake.requests.filter((request) => request.method === "tools/list"),
    ).toHaveLength(64);
  });
});
