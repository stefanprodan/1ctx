// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A check's GET and its answer (docs/automations.md, The check). It
// reaches only what the run's tools could: a linked MCP server with its
// bearer, else the web as curl would, signed by the matching project
// credential. No error message is kept: one may name the URL's query.

import { credentialKey, mcpKey, WEB } from "../../shared/capabilities.ts";
import type {
  CheckFailure,
  CheckQuiet,
} from "../../shared/contracts/automation.ts";
import type { HttpMethod } from "../../shared/contracts/credential.ts";
import type { AgentServer } from "../../shared/contracts/mcp.ts";
import { originAllowed, type WebAccessMode } from "../../shared/web.ts";
import { escapedForms } from "../bash/index.ts";
import {
  headerValue,
  type KeyRead,
  underPrefix,
} from "../credentials/index.ts";
import { type Clock, sleep } from "../lib/clock.ts";
import { sha256 } from "../lib/ids.ts";
import { scrubValues } from "../lib/log.ts";
import type { Fetcher } from "../providers/index.ts";

export const CHECK_TIMEOUT_MS = 10_000;
// as many hops as curl follows
export const CHECK_REDIRECTS = 5;
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

// scope is where the key may go; null for an unsigned check
export type Signing = {
  headers: Record<string, string>;
  scope: { prefix: string } | { origin: string } | null;
  // scrubbed from the answer, as curl and MCP scrub what a server echoes
  key: string | null;
};

const UNSIGNED: Signing = { headers: {}, scope: null, key: null };

export const KEY_MARK = "[key]";

// the web row and the task's web switch, as curl's sandbox has them
function webRefusal(
  ports: Pick<CheckPorts, "web">,
  ask: Pick<CheckAsk, "disabled">,
  url: URL,
  listed = true,
): CheckFailure | null {
  const web = ports.web();
  if (web.mode === "off" || ask.disabled.includes(WEB)) {
    return "web access is off";
  }
  if (listed && web.mode === "listed" && !originAllowed(url, web.domains)) {
    return "host is not in Web access";
  }
  return null;
}

// what signs the GET to the check URL, or why it may not go
export function reach(
  ports: Omit<CheckPorts, "fetch">,
  ask: CheckAsk,
): Signing | CheckFailure {
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
    return key === null
      ? UNSIGNED
      : {
          headers: { authorization: `Bearer ${key}` },
          scope: { origin: url.origin },
          key,
        };
  }
  const credential =
    url.protocol === "https:"
      ? ports
          .credentials(ask.projectId)
          .find((row) => underPrefix(ask.url, row.prefix))
      : undefined;
  const signs = credential?.methods.includes("GET") === true;
  // curl's credential fetch allows its own prefix, listed or not
  const refused = webRefusal(ports, ask, url, credential === undefined);
  if (refused !== null) return refused;
  if (credential === undefined) return UNSIGNED;
  // curl refuses a prefix whose credential is off, keyless or not for GET
  if (ask.disabled.includes(credentialKey(credential.id))) {
    return "its credential is turned off";
  }
  if (!signs) return "its credential does not allow GET";
  const read = ports.readKey(credential.keyName);
  if (!read.ok) return "its credential has no key";
  return {
    headers: {
      [credential.header]: headerValue(credential.template, read.key),
    },
    scope: { prefix: credential.prefix },
    key: read.key,
  };
}

// a redirect's next hop, or why the check stops there. A signed check
// stays inside its key's scope; an unsigned one meets the web rules on
// every hop and stays unsigned, a credential's prefix included
export function hop(
  ports: Pick<CheckPorts, "web">,
  ask: Pick<CheckAsk, "disabled">,
  signing: Signing,
  next: URL,
): CheckFailure | null {
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    return "could not connect";
  }
  const scope = signing.scope;
  if (scope !== null && "prefix" in scope) {
    return underPrefix(next.href, scope.prefix)
      ? null
      : "redirected outside its credential's URL";
  }
  if (scope !== null) {
    return next.origin === scope.origin
      ? null
      : "redirected away from its MCP server";
  }
  return webRefusal(ports, ask, next);
}

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

// a list or a search with nothing in it. Linear, whatever white space
// the brackets hold
const EMPTY = /^(?:\[[ \t\n\r]*\]|\{[ \t\n\r]*\}|null)?$/;

function isEmpty(text: string): boolean {
  return EMPTY.test(text.trim());
}

export async function answerOf(
  response: Response,
  ask: Pick<CheckAsk, "hash" | "maxBytes">,
): Promise<CheckAnswer> {
  const status = response.status;
  if (status !== 200) {
    await response.body?.cancel().catch(() => {});
    if (status === 204 || status === 304) return { result: `${status}` };
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

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// null when the signal, a drain, ended it
export async function check(
  ports: CheckPorts,
  clock: Clock,
  ask: CheckAsk,
  signal: AbortSignal,
): Promise<CheckAnswer | null> {
  const signing = reach(ports, ask);
  if (typeof signing === "string") return { result: signing };
  // the validators belong to the check URL's answer, wherever it ends
  const headers: Record<string, string> = { ...signing.headers };
  if (ask.etag !== null) headers["if-none-match"] = ask.etag;
  if (ask.lastModified !== null) {
    headers["if-modified-since"] = ask.lastModified;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  // one timeout for the whole chain
  const timer = sleep(clock, CHECK_TIMEOUT_MS);
  void timer.promise.then(() => {
    timedOut = true;
    controller.abort();
  });
  try {
    let url = new URL(ask.url);
    for (let hops = 0; ; hops++) {
      const response = await ports.fetch(url.href, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || location === null) {
        const answer = await answerOf(response, ask);
        if (answer.result !== "200" || signing.key === null) return answer;
        const forms = escapedForms(signing.key);
        // a validator echoing the key is never stored or sent again
        const clean = (value: string | null) =>
          value !== null && forms.some((form) => value.includes(form))
            ? null
            : value;
        // the hash stays the raw body's, so a scrub never hides a change
        return {
          ...answer,
          body: scrubValues(answer.body, forms, KEY_MARK),
          etag: clean(answer.etag),
          lastModified: clean(answer.lastModified),
        };
      }
      await response.body?.cancel().catch(() => {});
      if (hops === CHECK_REDIRECTS) return { result: "too many redirects" };
      const next = URL.parse(location, url);
      if (next === null) return { result: "could not connect" };
      const refused = hop(ports, ask, signing, next);
      if (refused !== null) return { result: refused };
      url = next;
    }
  } catch {
    if (signal.aborted) return null;
    if (timedOut) return { result: "timed out" };
    return { result: "could not connect" };
  } finally {
    timer.cancel();
    signal.removeEventListener("abort", stop);
  }
}
