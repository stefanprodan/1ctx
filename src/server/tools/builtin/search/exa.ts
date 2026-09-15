// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Exa wire: an MCP tools/call over its endpoint, answered as JSON or
// as a single SSE message. Nothing here reads a key file or reaches the
// network; the area passes the key and the version, the caller does the
// request.

import { isObject, jsonObject, unexpected } from "./answer.ts";
import {
  ProviderError,
  type ProviderRequest,
  type SearchArgs,
} from "./types.ts";

function messageData(body: string): string {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  let event = "message";
  let data: string[] = [];
  const dispatch = () => {
    if (event === "message" && data.length > 0) return data.join("\n");
    event = "message";
    data = [];
    return null;
  };
  for (const line of lines) {
    if (line === "") {
      const value = dispatch();
      if (value !== null) return value;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return dispatch() ?? unexpected();
}

function serverMessage(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return unexpected();
  return value.replace(/^MCP error -?\d+:\s*/u, "");
}

export const EXA_URL = "https://mcp.exa.ai/mcp";

export function buildRequest(
  args: SearchArgs,
  key: string | null,
  version: string,
): ProviderRequest {
  const query = args.domain ? `${args.query} site:${args.domain}` : args.query;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": `1ctx/${version}`,
  };
  if (key !== null) headers["x-api-key"] = key;
  return {
    url: EXA_URL,
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, numResults: 5 },
      },
    }),
  };
}

export function parseAnswer(
  body: string,
  contentType: string | null,
  keySent: boolean,
): string {
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  const envelope = jsonObject(
    mediaType === "application/json" ? body : messageData(body),
  );
  if (envelope.error !== undefined) {
    if (!isObject(envelope.error)) return unexpected();
    throw new ProviderError(serverMessage(envelope.error.message));
  }
  const record = envelope.result;
  if (!isObject(record) || !Array.isArray(record.content)) return unexpected();
  const texts: string[] = [];
  for (const item of record.content) {
    if (!isObject(item) || item.type !== "text") return unexpected();
    if (typeof item.text !== "string") return unexpected();
    texts.push(item.text);
  }
  const text = texts.join("\n\n");
  if (record.isError === true) {
    const message = serverMessage(text);
    throw new ProviderError(
      message,
      keySent && message.startsWith("web_search_exa error (401)"),
    );
  }
  return text.trim() === "" ? "No results." : text;
}
