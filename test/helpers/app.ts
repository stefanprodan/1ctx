// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server composed as the binary composes it, over a memory db and a
// fake clock, with the request helper: call(method, path, options) goes
// through the router exactly as Bun.serve would, cookie jar included.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type App, compose } from "../../src/server/compose.ts";
import type { Db } from "../../src/server/db/index.ts";
import { silent } from "../../src/server/lib/log.ts";
import type { Registry } from "../../src/server/runner/index.ts";
import type { Tools } from "../../src/server/tools/index.ts";
import { ADMIN_SECRET } from "../../src/server/users/index.ts";
import { clientAddress } from "../../src/server/web/serve.ts";
import { isSecretName, SECRET_KINDS } from "../../src/shared/words.ts";
import { memoryDb } from "./db.ts";

export const ORIGIN = "http://1ctx.test";
// where a test's provider lives: the fake fetch answers it and nothing
// else, so the suite never reaches a network
export const PROVIDER_URL = "http://models.test/v1";
export const GEMINI_URL = "http://models.test/v1beta";

const fixture = (...parts: string[]) =>
  readFileSync(join(import.meta.dir, "..", "fixtures", ...parts), "utf8");
const catalogBody = () => fixture("providers", "models.json");
// a reply with reasoning, content, a finish and usage, in the shape of
// the wire the request went out on: the OpenRouter recording for its
// body (usage asked for, the reasoning object), and for the plain wire
// the same reply derived from it with the reasoning under
// reasoning_content and no cost, since the one recorded from an
// OpenAI-compatible server is cut by length with no content
const chatBody = (body: string | null) =>
  body?.includes('"stream_options"')
    ? fixture("providers", "openai", "chat-reply.sse")
    : fixture("providers", "openrouter", "chat-stream.sse");

const geminiChatBody = (body: string | null) => {
  const request = JSON.parse(body ?? "{}");
  const tools =
    request.tools?.length > 0 &&
    !request.messages?.some(
      (message: { role: string }) => message.role === "tool",
    );
  return fixture(
    "providers",
    "gemini",
    tools ? "chat-tools.sse" : "chat-stream.sse",
  );
};

export type FakeCall = {
  url: string;
  headers: Record<string, string>;
  body: string | null;
};

// the recorded catalog and the recorded chat for the fake provider, a
// 502-worthy answer for any other host; every call is kept so a test
// can see what went out
export function fakeFetch(): { fetcher: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, headers, body });
    if (url === `${PROVIDER_URL}/models`) {
      return new Response(catalogBody(), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === `${PROVIDER_URL}/chat/completions`) {
      return new Response(chatBody(body), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url === `${GEMINI_URL}/models?pageSize=1000`) {
      return new Response(fixture("providers", "gemini", "models.json"), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === `${GEMINI_URL}/openai/chat/completions`) {
      return new Response(geminiChatBody(body), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new TypeError("unable to connect");
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
export const VERSION = "v0.0.0-test";

export type TestApp = App & {
  db: Db;
  now: { value: number };
  // what the fake fetch was asked
  fetched: FakeCall[];
  // one cookie jar per client: a browser tab, or another user's
  client(address?: string): TestClient;
};

export type TestClient = {
  cookie: string | null;
  call(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      // a raw body, sent as is
      raw?: string;
      headers?: Record<string, string>;
      origin?: string | null;
    },
  ): Promise<Response>;
  login(username: string, password: string): Promise<Response>;
};

export async function testApp(
  options: {
    adminPassword?: string | null;
    trustProxy?: boolean;
    fetcher?: typeof fetch;
    // the secrets beside user-admin.key
    secrets?: Record<string, string>;
    // a fake tools capability for runner state-machine tests
    tools?: Tools;
    // a runner registry with its own caps
    registry?: Registry;
    activate?: boolean;
  } = {},
): Promise<TestApp> {
  const db = memoryDb();
  let current = 1_000_000;
  const sleepers = new Set<{ at: number; resolve: () => void }>();
  const now = {
    get value() {
      return current;
    },
    set value(value: number) {
      current = value;
      for (const sleeper of [...sleepers]) {
        if (sleeper.at > current) continue;
        sleepers.delete(sleeper);
        sleeper.resolve();
      }
    },
  };
  const clock = Object.assign(() => current, {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.add({ at: current + ms, resolve });
      }),
  });
  const trustProxy = options.trustProxy ?? false;
  const adminPassword =
    options.adminPassword === undefined
      ? "hunter2-test"
      : options.adminPassword;
  const fake = fakeFetch();
  const values: Record<string, string> = { ...options.secrets };
  if (adminPassword !== null) values[ADMIN_SECRET] = adminPassword;
  const app = await compose({
    db,
    secret: (kind, name) => {
      if (!isSecretName(kind, name)) throw new Error("bad secret name");
      return values[name]?.trim() || null;
    },
    secretNames: (kind) => {
      if (!SECRET_KINDS.some((known) => known === kind)) {
        throw new Error("bad secret kind");
      }
      return Object.keys(values)
        .filter((name) => isSecretName(kind, name))
        .sort();
    },
    clock,
    fetcher: options.fetcher ?? fake.fetcher,
    log: () => silent,
    version: VERSION,
    secureCookie: false,
    trustProxy,
    tools: options.tools,
    registry: options.registry,
    activate: options.activate,
  });
  return {
    ...app,
    db,
    now,
    fetched: fake.calls,
    client(address = "127.0.0.1") {
      const client: TestClient = {
        cookie: null,
        async call(method, path, opts = {}) {
          const headers = new Headers(opts.headers);
          headers.set("host", "1ctx.test");
          if (opts.origin !== null && method !== "GET") {
            headers.set("origin", opts.origin ?? ORIGIN);
          }
          if (client.cookie) headers.set("cookie", client.cookie);
          if (opts.body !== undefined || opts.raw !== undefined) {
            headers.set("content-type", "application/json");
          }
          const body =
            opts.raw ??
            (opts.body === undefined ? undefined : JSON.stringify(opts.body));
          const req = new Request(`${ORIGIN}${path}`, {
            method,
            headers,
            body,
          });
          // the address as serve() would derive it; without an upgrader
          // the router always answers, an upgrade route with a 426
          const res = (await app.handle(
            req,
            clientAddress(req, address, trustProxy),
          ))!;
          const set = res.headers.get("set-cookie");
          if (set) {
            const [pair] = set.split(";");
            const [, value] = pair.split("=");
            client.cookie = value ? pair : null;
          }
          return res;
        },
        login(username, password) {
          return client.call("POST", "/api/login", {
            body: { username, password },
          });
        },
      };
      return client;
    },
  };
}
