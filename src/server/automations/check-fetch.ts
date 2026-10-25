// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A check's one GET and what its answer says (docs/automations.md, The
// check). It reaches what the run's own tools could: an MCP server's
// origin with its bearer, else the web as curl would, signed by the
// project credential the URL is under. No error's message is kept,
// since one may name the URL and its query.

import { credentialKey, mcpKey, WEB } from "../../shared/capabilities.ts";
import type {
  CheckFailure,
  CheckQuiet,
} from "../../shared/contracts/automation.ts";
import type { HttpMethod } from "../../shared/contracts/credential.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import { originAllowed, type WebAccessMode } from "../../shared/web.ts";
import {
  headerValue,
  type KeyRead,
  underPrefix,
} from "../credentials/index.ts";
import { type Clock, sleep } from "../lib/clock.ts";
import { sha256 } from "../lib/ids.ts";
import type { Fetcher } from "../providers/index.ts";

export const CHECK_TIMEOUT_MS = 10_000;
export const MAX_CHECK_BYTES = 4 * 1024 * 1024;

export type CheckPorts = {
  fetch: Fetcher;
  web(): { mode: WebAccessMode; domains: string[] };
  mcpServers(): { id: string; url: string; keyName: string | null }[];
  // an mcp- key file's value, read at the moment of use
  mcpKey(keyName: string): string | null;
  credentials(projectId: string): {
    id: string;
    prefix: string;
    header: string;
    template: string;
    keyName: string;
    methods: HttpMethod[];
  }[];
  readKey(keyName: string): KeyRead;
};

export type CheckAsk = {
  url: string;
  projectId: string;
  // the task's agent's MCP servers, and what the task turned off
  servers: readonly AgentServer[];
  disabled: readonly string[];
  // what the answer that started the last run said
  etag: string | null;
  lastModified: string | null;
  hash: string | null;
  maxBytes: number;
};

export type NewAnswer = {
  result: "200";
  body: string;
  hash: string;
  etag: string | null;
  lastModified: string | null;
};

export type CheckAnswer =
  | { result: CheckQuiet }
  | { result: CheckFailure }
  | NewAnswer;

// the headers that sign the GET, or why it may not go
export function reach(
  ports: Omit<CheckPorts, "fetch">,
  ask: CheckAsk,
): Record<string, string> | CheckFailure {
  const url = new URL(ask.url);
  const linked = new Set(
    ask.servers
      .filter((link) => !ask.disabled.includes(mcpKey(link.serverId)))
      .map((link) => link.serverId),
  );
  // the web row never applies to an MCP server, as to its calls
  const server = ports
    .mcpServers()
    .find(
      (row) => linked.has(row.id) && URL.parse(row.url)?.origin === url.origin,
    );
  if (server !== undefined) {
    const key = server.keyName === null ? null : ports.mcpKey(server.keyName);
    return key === null ? {} : { authorization: `Bearer ${key}` };
  }
  const web = ports.web();
  if (web.mode === "off" || ask.disabled.includes(WEB)) {
    return "needs web access";
  }
  if (web.mode === "listed" && !originAllowed(url, web.domains)) {
    return "host not listed";
  }
  if (url.protocol !== "https:") return {};
  const credential = ports
    .credentials(ask.projectId)
    .find((row) => underPrefix(ask.url, row.prefix));
  // one turned off, keyless or without GET goes unsigned, as webfetch
  // would send it
  if (
    credential === undefined ||
    ask.disabled.includes(credentialKey(credential.id)) ||
    !credential.methods.includes("GET")
  ) {
    return {};
  }
  const read = ports.readKey(credential.keyName);
  return read.ok
    ? { [credential.header]: headerValue(credential.template, read.key) }
    : {};
}

// the body up to max bytes, or null past it
async function readUpTo(
  response: Response,
  max: number,
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// UTF-8 with no NUL, whatever the content type says
function textOf(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

// white space, [], {} or null: a list or a search with nothing in it
function isEmpty(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;
  if (trimmed.length > 16) return false;
  try {
    const value = JSON.parse(trimmed);
    return (
      value === null ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" && Object.keys(value).length === 0)
    );
  } catch {
    return false;
  }
}

export async function answerOf(
  response: Response,
  ask: Pick<CheckAsk, "hash" | "maxBytes">,
): Promise<CheckAnswer> {
  const status = response.status;
  if (status !== 200) {
    await response.body?.cancel().catch(() => {});
    if (status === 204 || status === 304) return { result: `${status}` };
    if (status >= 300 && status < 400) return { result: "redirected" };
    return { result: `HTTP ${status}` };
  }
  const bytes = await readUpTo(response, ask.maxBytes);
  if (bytes === null) return { result: "answer too large" };
  const body = textOf(bytes);
  if (body === null) return { result: "answer is not text" };
  if (isEmpty(body)) return { result: "empty" };
  const hash = sha256(bytes);
  if (hash === ask.hash) return { result: "unchanged" };
  return {
    result: "200",
    body,
    hash,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

// the GET and its answer; null when the signal, a drain, ended it
export async function check(
  ports: CheckPorts,
  clock: Clock,
  ask: CheckAsk,
  signal: AbortSignal,
): Promise<CheckAnswer | null> {
  const signing = reach(ports, ask);
  if (typeof signing === "string") return { result: signing };
  const headers: Record<string, string> = { ...signing };
  if (ask.etag !== null) headers["if-none-match"] = ask.etag;
  if (ask.lastModified !== null) {
    headers["if-modified-since"] = ask.lastModified;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  const timer = sleep(clock, CHECK_TIMEOUT_MS);
  void timer.promise.then(() => {
    timedOut = true;
    controller.abort();
  });
  try {
    // a 3xx is never followed, so a key never goes elsewhere
    const response = await ports.fetch(ask.url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    return await answerOf(response, ask);
  } catch (err) {
    if (signal.aborted) return null;
    if (timedOut) return { result: "timed out" };
    if ((err as { code?: unknown }).code === "UnexpectedRedirect") {
      return { result: "redirected" };
    }
    return { result: "could not connect" };
  } finally {
    timer.cancel();
    signal.removeEventListener("abort", stop);
  }
}
