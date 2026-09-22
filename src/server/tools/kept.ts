// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP result as the context and /mcp get it. What the context cannot
// hold is kept whole under /mcp and the context gets its start and the
// path; every embedded resource is a file, inlined too when it is small.
// The path lines are the result's tail, so every later cut keeps them.

import { type KeptFile, keptPath } from "../knowledge/index.ts";
import type { McpCallOutput, McpContent } from "../mcp/index.ts";
import type { KeepPort, ToolResult } from "./types.ts";

export const MAX_KEPT_PER_CALL = 50;

// the extension a blob gets when its name has none
const EXTENSIONS: Record<string, string> = Object.assign(Object.create(null), {
  "application/gzip": "gz",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/yaml": "yaml",
  "application/zip": "zip",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
});

function safe(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|-+$/g, "")
    .slice(0, 100);
}

// the last segment of the URI, made safe, unique within the call
function resourceName(
  uri: unknown,
  mimeType: unknown,
  blob: boolean,
  taken: Set<string>,
): string {
  let segment = "";
  if (typeof uri === "string") {
    const path = uri.split(/[?#]/)[0] ?? "";
    const last = path.split("/").filter(Boolean).pop() ?? "";
    try {
      segment = decodeURIComponent(last);
    } catch {
      segment = last;
    }
  }
  let name = safe(segment);
  if (name === "" || name === "result.json" || name === "result.txt") {
    name = `resource-${taken.size + 1}`;
  }
  if (blob && !name.includes(".") && typeof mimeType === "string") {
    const ext = EXTENSIONS[mimeType.split(";")[0]!.trim()];
    if (ext) name = `${name}.${ext}`;
  }
  let unique = name;
  for (let n = 2; taken.has(unique); n++) {
    const dot = name.lastIndexOf(".");
    unique =
      dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
  }
  taken.add(unique);
  return unique;
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function lineCount(text: string): number {
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i < text.length - 1) count++;
  }
  return count;
}

// the start, cut at a line when one ends in the second half of the room
function start(text: string, room: number): string {
  if (room <= 0) return "";
  if (text.length <= room) return text;
  const cut = text.slice(0, room);
  const line = cut.lastIndexOf("\n");
  return line >= room / 2 ? cut.slice(0, line) : cut;
}

function isJson(text: string): boolean {
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return false;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object";
  } catch {
    return false;
  }
}

type Resource = {
  uri: unknown;
  mimeType: unknown;
  text?: string;
  blob?: string;
};

function resourceOf(part: McpContent): Resource | null {
  if (part.type !== "resource") return null;
  const resource = part.resource;
  if (typeof resource !== "object" || resource === null) return null;
  const r = resource as Record<string, unknown>;
  if (typeof r.text === "string") {
    return { uri: r.uri, mimeType: r.mimeType, text: r.text };
  }
  if (typeof r.blob === "string") {
    return { uri: r.uri, mimeType: r.mimeType, blob: r.blob };
  }
  return null;
}

/**
 * The tool result for an MCP answer: the plain text when nothing is kept
 * (no bash in the send, a small answer without resources), else the text
 * or its start with the /mcp paths as the tail, and the files to keep.
 */
export function shapeMcpResult(
  output: McpCallOutput,
  toolName: string,
  keep: KeepPort | null | undefined,
  cut: number,
): string | ToolResult {
  if (!keep) return output.text;
  const resources = output.content.map(resourceOf);
  if (!resources.some(Boolean) && output.text.length <= cut) return output.text;

  // the folder's number is taken on the first file, in finish order
  let number = 0;
  let dir = "";
  const folder = () => {
    if (number === 0) {
      number = keep.take();
      dir = `${String(number).padStart(4, "0")}-${safe(toolName) || "tool"}`;
    }
    return dir;
  };
  const files: KeptFile[] = [];
  const taken = new Set<string>();
  const saved: string[] = [];
  let skipped = 0;
  const keepFile = (
    name: string,
    text: string | null,
    data: Uint8Array | null,
  ) => {
    const bytes =
      text !== null ? Buffer.byteLength(text) : (data?.byteLength ?? 0);
    const at = folder();
    files.push({ folder: number, dir: at, name, text, data, bytes });
    return keptPath(folder(), name);
  };

  // the text as resultText gives it, a large resource left to its file
  const pieces: string[] = [];
  const structured =
    !output.content.some((part) => part.type === "text") &&
    output.structured !== undefined;
  if (structured) pieces.push(JSON.stringify(output.structured));
  output.content.forEach((part, index) => {
    const resource = resources[index];
    if (resource) {
      if (files.length >= MAX_KEPT_PER_CALL - 1) {
        skipped++;
        if (!structured) pieces.push(resource.text ?? "[resource omitted]");
        return;
      }
      const name = resourceName(
        resource.uri,
        resource.mimeType,
        resource.blob !== undefined,
        taken,
      );
      const data =
        resource.blob !== undefined
          ? new Uint8Array(Buffer.from(resource.blob, "base64"))
          : null;
      const path = keepFile(name, resource.text ?? null, data);
      if (
        !structured &&
        resource.text !== undefined &&
        resource.text.length <= cut
      ) {
        pieces.push(resource.text);
      }
      saved.push(
        `saved: ${path}${resource.text === undefined ? ` (${size(data!.byteLength)})` : ""}`,
      );
      return;
    }
    if (structured) return;
    if (part.type === "text" && typeof part.text === "string")
      pieces.push(part.text);
    else if (part.type === "image") pieces.push("[image omitted]");
    else if (part.type === "audio") pieces.push("[audio omitted]");
    else if (part.type === "resource") pieces.push("[resource omitted]");
    else if (part.type === "resource_link" && typeof part.uri === "string") {
      pieces.push(part.uri);
    }
  });
  const text = pieces.join("\n");

  const lines: string[] = [];
  if (text.length > cut) {
    const json = isJson(text);
    const path = keepFile(json ? "result.json" : "result.txt", text, null);
    lines.push(
      `whole result: ${path}, ${lineCount(text).toLocaleString("en-US")} lines, ${size(Buffer.byteLength(text))}: query it with ${json ? "jq" : "yq, rg or sed"}`,
    );
  }
  lines.push(...saved);
  if (skipped > 0) {
    lines.push(
      `${skipped} more resources not kept: at most ${MAX_KEPT_PER_CALL} files per call`,
    );
  }

  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > keep.maxBytes) {
    // too large for the chat's budget: the plain cut, saying so
    const note = `not kept: ${size(total)} is over this chat's ${size(keep.maxBytes)} for MCP results`;
    return {
      content: `${output.text}\n${note}`,
      error: false,
      tail: note.length,
    };
  }
  const tail = lines.join("\n");
  const body = text.length > cut ? start(text, cut - tail.length - 1) : text;
  return {
    content: `${body}\n${tail}`,
    error: false,
    tail: tail.length,
    kept: files,
  };
}
