// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP answer as the context gets it: whole when it fits, else its start
// with the kept file's path as the tail; a resource inlined when it is
// small text, kept as a file otherwise.

import { describe, expect, test } from "bun:test";
import type { McpCallOutput } from "../../../src/server/mcp/index.ts";
import { cutResult, fitResults } from "../../../src/server/runner/results.ts";
import {
  MAX_KEPT_PER_CALL,
  shapeMcpResult,
} from "../../../src/server/tools/kept.ts";
import type { ToolResult } from "../../../src/server/tools/types.ts";

function keep(start = 12, maxBytes = 32 * 1024 * 1024) {
  let next = start;
  return { take: () => next++, maxBytes, used: 0, maxFiles: 2000, files: 0 };
}

const text = (value: string): McpCallOutput => ({
  text: value,
  content: [{ type: "text", text: value }],
  structured: undefined,
});

const yaml = Array.from(
  { length: 400 },
  (_, i) => `---\nkind: Deployment\nmetadata:\n  name: app-${i}\n`,
).join("");

describe("MCP results kept under /mcp", () => {
  test("an answer that fits is the plain text, nothing kept", () => {
    expect(shapeMcpResult(text("small"), "get", keep(), 1000)).toBe("small");
  });

  test("without bash in the send nothing is kept", () => {
    expect(shapeMcpResult(text(yaml), "get", null, 1000)).toBe(yaml);
  });

  test("a long answer keeps the whole text and gives its start and path", () => {
    const result = shapeMcpResult(
      text(yaml),
      "get_kubernetes_resources",
      keep(),
      1000,
    ) as ToolResult;
    expect(result.content.length).toBeLessThanOrEqual(1000);
    expect(result.kept).toHaveLength(1);
    expect(result.kept![0]).toMatchObject({
      folder: 12,
      dir: "0012-get_kubernetes_resources",
      name: "result.txt",
      text: yaml,
      bytes: Buffer.byteLength(yaml),
    });
    const tail = result.content.slice(-result.tail!);
    expect(tail).toBe(
      "whole result: /mcp/0012-get_kubernetes_resources/result.txt, 1,600 lines, 18 KB: query it with yq, rg or sed",
    );
    // the start ends at a line
    expect(
      yaml.startsWith(result.content.slice(0, -tail.length - 1)),
    ).toBeTrue();
    expect(
      result.content.slice(0, -tail.length - 1).endsWith("\n"),
    ).toBeFalse();
  });

  test("a JSON answer is result.json, and one line is cut by characters", () => {
    const json = JSON.stringify(
      Array.from({ length: 200 }, (_, i) => ({ id: i, name: `n${i}` })),
    );
    const result = shapeMcpResult(
      text(json),
      "list",
      keep(1),
      1000,
    ) as ToolResult;
    expect(result.kept![0]!.name).toBe("result.json");
    expect(result.content.slice(-result.tail!)).toContain("query it with jq");
    const body = result.content.slice(0, -result.tail! - 1);
    expect(body.length).toBeGreaterThan(500);
    expect(json.startsWith(body)).toBeTrue();
  });

  test("the path survives every later cut", () => {
    const result = shapeMcpResult(
      text(yaml),
      "get",
      keep(),
      5000,
    ) as ToolResult;
    const tail = result.content.slice(-result.tail!);
    expect(cutResult(result, 2000).content.endsWith(tail)).toBeTrue();
    const fitted = fitResults(
      [{ id: "c", name: "get", arguments: "{}" }],
      [result],
      300,
    );
    expect(fitted.results[0]!.content).toContain(tail);
  });

  test("a small text resource is inlined and not kept", () => {
    const output: McpCallOutput = {
      text: "",
      content: [
        { type: "text", text: "downloaded" },
        {
          type: "resource",
          resource: { uri: "repo://o/r/a.csv", text: "ticker,shares\n" },
        },
      ],
      structured: undefined,
    };
    expect(shapeMcpResult(output, "get", keep(), 1000)).toBe(
      "downloaded\nticker,shares\n",
    );
  });

  test("a resource past the cut is kept, named from its URI", () => {
    const csv = `ticker,shares\n${"ACME,10\n".repeat(30)}`;
    const output: McpCallOutput = {
      text: "",
      content: [
        { type: "text", text: "successfully downloaded text file (SHA: abc)" },
        {
          type: "resource",
          resource: {
            uri: "repo://o/r/sha/1/contents/data/portfolio_stock.csv",
            mimeType: "text/plain; charset=utf-8",
            text: csv,
          },
        },
      ],
      structured: undefined,
    };
    const result = shapeMcpResult(
      output,
      "get_file_contents",
      keep(7),
      200,
    ) as ToolResult;
    expect(result.content).toBe(
      "successfully downloaded text file (SHA: abc)\nsaved: /mcp/0007-get_file_contents/portfolio_stock.csv",
    );
    expect(result.kept).toEqual([
      {
        folder: 7,
        dir: "0007-get_file_contents",
        name: "portfolio_stock.csv",
        text: csv,
        data: null,
        bytes: 254,
      },
    ]);
  });

  test("a large resource is its saved line alone, a blob keeps its bytes", () => {
    const big = "x".repeat(5000);
    const output: McpCallOutput = {
      text: "",
      content: [
        { type: "resource", resource: { uri: "file:///a/big.txt", text: big } },
        {
          type: "resource",
          resource: {
            uri: "file:///a/chart",
            mimeType: "image/png",
            blob: Buffer.from([1, 2, 3]).toString("base64"),
          },
        },
        { type: "resource", resource: { uri: "file:///b/big.txt", text: "y" } },
      ],
      structured: undefined,
    };
    const result = shapeMcpResult(output, "read", keep(3), 1000) as ToolResult;
    expect(result.content).not.toContain(big);
    expect(result.content).toBe(
      "y\nsaved: /mcp/0003-read/big.txt\nsaved: /mcp/0003-read/chart.png (3 bytes)",
    );
    expect(result.kept![1]!.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a URI segment that leaves nothing gets a resource name", () => {
    const output: McpCallOutput = {
      text: "",
      content: [
        { type: "resource", resource: { uri: "x://h/../", blob: "YQ==" } },
        { type: "resource", resource: { uri: "x://h/%2F..%2F", blob: "Yg==" } },
        { type: "resource", resource: { uri: 7, blob: "Yw==" } },
      ],
      structured: undefined,
    };
    const result = shapeMcpResult(output, "r/../x", keep(), 1000) as ToolResult;
    for (const file of result.kept!) {
      expect(file.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(file.dir).toMatch(/^0012-[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
    expect(new Set(result.kept!.map((file) => file.name)).size).toBe(3);
  });

  test("a call keeps at most its cap of files, the rest named as not kept", () => {
    const content = Array.from({ length: MAX_KEPT_PER_CALL + 5 }, (_, i) => ({
      type: "resource",
      resource: { uri: `x://h/f${i}.txt`, blob: "YQ==" },
    }));
    const result = shapeMcpResult(
      { text: "", content, structured: undefined },
      "list",
      keep(),
      100_000,
    ) as ToolResult;
    expect(result.kept).toHaveLength(MAX_KEPT_PER_CALL - 1);
    expect(result.content).toContain(
      `6 more resources not kept: at most ${MAX_KEPT_PER_CALL - 1} per call`,
    );
  });

  test("an answer over the chat's budget is the plain text, saying so", () => {
    const result = shapeMcpResult(
      text(yaml),
      "get",
      keep(1, 1024),
      1000,
    ) as ToolResult;
    expect(result.kept).toBeUndefined();
    expect(result.content.startsWith(yaml)).toBeTrue();
    expect(result.content.slice(-result.tail!)).toBe(
      "not kept: 18 KB more would pass this chat's 1 KB for MCP results",
    );
  });

  test("folders are numbered in the order calls keep, one per call", () => {
    const port = keep(40);
    const first = shapeMcpResult(text(yaml), "a", port, 1000) as ToolResult;
    expect(shapeMcpResult(text("small"), "b", port, 1000)).toBe("small");
    const second = shapeMcpResult(text(yaml), "c", port, 1000) as ToolResult;
    expect(first.kept![0]!.dir).toBe("0040-a");
    expect(second.kept![0]!.dir).toBe("0041-c");
  });

  test("a character cut never splits a surrogate pair", () => {
    const json = JSON.stringify(Array.from({ length: 500 }, () => "😀"));
    const result = shapeMcpResult(
      text(json),
      "emoji",
      keep(),
      1000,
    ) as ToolResult;
    const body = result.content.slice(0, -result.tail! - 1);
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBeFalse();
    expect(result.content.slice(-result.tail!)).toContain("1 line,");
  });

  test("the budget counts this send's files too", () => {
    const port = { ...keep(1, 30 * 1024), used: 0 };
    const first = shapeMcpResult(text(yaml), "a", port, 1000) as ToolResult;
    expect(first.kept).toHaveLength(1);
    const second = shapeMcpResult(text(yaml), "b", port, 1000) as ToolResult;
    expect(second.kept).toBeUndefined();
    expect(second.content).toContain("more would pass this chat's 30 KB");
  });

  test("a small text resource beside structured content is kept", () => {
    const output: McpCallOutput = {
      text: "",
      content: [
        { type: "resource", resource: { uri: "x://h/a.txt", text: "small" } },
      ],
      structured: { count: 1 },
    };
    const result = shapeMcpResult(output, "get", keep(5), 1000) as ToolResult;
    expect(result.content).toBe('{"count":1}\nsaved: /mcp/0005-get/a.txt');
    expect(result.kept?.map((file) => file.name)).toEqual(["a.txt"]);
  });

  test("the file cap counts this send's files too", () => {
    const port = { ...keep(1), maxFiles: 1 };
    const first = shapeMcpResult(text(yaml), "a", port, 1000) as ToolResult;
    expect(first.kept).toHaveLength(1);
    const second = shapeMcpResult(text(yaml), "b", port, 1000) as ToolResult;
    expect(second.kept).toBeUndefined();
    expect(second.content).toContain(
      "not kept: 1 more file would pass this chat's 1 for MCP results",
    );
  });

  test("many saved lines become one naming the folder", () => {
    const content = Array.from({ length: 40 }, (_, i) => ({
      type: "resource",
      resource: { uri: `x://h/${"n".repeat(60)}${i}.txt`, blob: "YQ==" },
    }));
    const result = shapeMcpResult(
      { text: "", content, structured: undefined },
      "list",
      keep(3),
      1000,
    ) as ToolResult;
    expect(result.kept).toHaveLength(40);
    expect(result.content.slice(-result.tail!)).toBe(
      "saved: 40 files in /mcp/0003-list/: list them with ls",
    );
  });
});
