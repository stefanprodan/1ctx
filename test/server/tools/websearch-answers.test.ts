// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseAnswer as parseExaAnswer } from "../../../src/server/tools/builtin/search/exa.ts";
import { parseAnswer as parseFirecrawlAnswer } from "../../../src/server/tools/builtin/search/firecrawl.ts";
import { parseAnswer as parseTavilyAnswer } from "../../../src/server/tools/builtin/search/tavily.ts";
import { searchWeb } from "../../../src/server/tools/builtin/websearch.ts";
import {
  context,
  dependencies,
  exaFixture,
  exaPayload,
  exaResponse,
  exaText,
  firecrawlFixture,
  search,
  tavilyFixture,
  thrown,
} from "./websearch.helpers.ts";

describe("Exa answers", () => {
  test("returns the recorded SSE text byte for byte and accepts JSON", () => {
    expect(parseExaAnswer(exaFixture, "text/event-stream", false)).toBe(
      exaText,
    );
    expect(parseExaAnswer(exaPayload, "application/json", false)).toBe(exaText);
  });

  test("joins SSE data lines and multiple text items", () => {
    const split = `event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"content":[{"type":"text","text":"joined"}]}}\n\n`;
    expect(parseExaAnswer(split, "text/event-stream", false)).toBe("joined");
    const multiple = JSON.stringify({
      result: {
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    });
    expect(parseExaAnswer(multiple, "application/json", false)).toBe(
      "one\n\ntwo",
    );
    expect(
      parseExaAnswer(
        JSON.stringify({ result: { content: [{ type: "text", text: " " }] } }),
        "application/json",
        false,
      ),
    ).toBe("No results.");
  });

  test("rejects malformed SSE, JSON and result shapes", () => {
    for (const [body, type] of [
      ["event: message\n\n", "text/event-stream"],
      ["event: message\ndata: nope\n\n", "text/event-stream"],
      [JSON.stringify({ result: { content: "bad" } }), "application/json"],
    ]) {
      expect(() => parseExaAnswer(body, type, false)).toThrow(
        "websearch answered with an unexpected shape",
      );
    }
  });

  test("passes server errors through and strips the MCP prefix", () => {
    expect(() =>
      parseExaAnswer(
        JSON.stringify({ error: { code: -32602, message: "bad params" } }),
        "application/json",
        false,
      ),
    ).toThrow("bad params");
    const unknown = JSON.stringify({
      result: {
        isError: true,
        content: [
          { type: "text", text: "MCP error -32602: Tool nope not found" },
        ],
      },
    });
    expect(() => parseExaAnswer(unknown, "application/json", false)).toThrow(
      "Tool nope not found",
    );
  });

  test("maps the recorded bad-key result only when a key was sent", async () => {
    const badKey = JSON.stringify({
      result: {
        isError: true,
        content: [
          { type: "text", text: "web_search_exa error (401): Invalid API key" },
        ],
      },
    });
    const keyed = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search("exa", "bad"),
        "vtest",
        dependencies(async () => exaResponse(badKey)),
      ),
    );
    expect(keyed.message).toBe(
      "websearch key rejected: web_search_exa error (401): Invalid API key",
    );
    const keyless = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search("exa"),
        "vtest",
        dependencies(async () => exaResponse(badKey)),
      ),
    );
    expect(keyless.message).toBe("web_search_exa error (401): Invalid API key");
  });
});

describe("Firecrawl answers", () => {
  test("formats the recorded hits", () => {
    const source = JSON.parse(firecrawlFixture).data.web as Array<{
      title: string;
      url: string;
      description: string;
    }>;
    const expected = source
      .map(
        (hit, index) =>
          `${index + 1}. ${hit.title}\n${hit.url}\n${hit.description}`,
      )
      .join("\n\n");
    expect(parseFirecrawlAnswer(firecrawlFixture)).toBe(expected);
  });

  test("skips missing URLs, keeps contiguous numbers and empty fields", () => {
    const answer = JSON.stringify({
      success: true,
      data: {
        web: [
          { title: "one", url: "https://one", description: "first" },
          { title: "drop", description: "missing URL" },
          { title: 3, url: "https://three", description: 3 },
        ],
      },
    });
    expect(parseFirecrawlAnswer(answer)).toBe(
      "1. one\nhttps://one\nfirst\n\n2. \nhttps://three\n",
    );
    expect(
      parseFirecrawlAnswer(
        JSON.stringify({ success: true, data: { web: [] } }),
      ),
    ).toBe("No results.");
  });

  test("reports provider and shape errors", () => {
    expect(() =>
      parseFirecrawlAnswer(JSON.stringify({ success: false, error: "denied" })),
    ).toThrow("denied");
    for (const body of [
      "not json",
      JSON.stringify({ success: true }),
      JSON.stringify({ success: true, data: {} }),
    ]) {
      expect(() => parseFirecrawlAnswer(body)).toThrow(
        "websearch answered with an unexpected shape",
      );
    }
  });
});

describe("Tavily answers", () => {
  test("formats the recorded hits", () => {
    const source = JSON.parse(tavilyFixture).results as Array<{
      title: string;
      url: string;
      content: string;
    }>;
    expect(source.length).toBeGreaterThan(0);
    const expected = source
      .map(
        (hit, index) =>
          `${index + 1}. ${hit.title}\n${hit.url}\n${hit.content}`,
      )
      .join("\n\n");
    expect(parseTavilyAnswer(tavilyFixture)).toBe(expected);
  });

  test("skips missing URLs, keeps contiguous numbers and empty fields", () => {
    const answer = JSON.stringify({
      results: [
        { title: "one", url: "https://one", content: "first" },
        { title: "drop", content: "missing URL" },
        { title: 3, url: "https://three", content: 3 },
      ],
    });
    expect(parseTavilyAnswer(answer)).toBe(
      "1. one\nhttps://one\nfirst\n\n2. \nhttps://three\n",
    );
    expect(parseTavilyAnswer(JSON.stringify({ results: [] }))).toBe(
      "No results.",
    );
  });

  test("reports a shape error", () => {
    for (const body of ["not json", "[]", JSON.stringify({ query: "x" })]) {
      expect(() => parseTavilyAnswer(body)).toThrow(
        "websearch answered with an unexpected shape",
      );
    }
  });
});
