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
import { clientAddress } from "../../src/server/web/serve.ts";
import { memoryDb } from "./db.ts";

export const ORIGIN = "http://1ctx.test";
// where a test's provider lives: the fake fetch answers it and nothing
// else, so the suite never reaches a network
export const PROVIDER_URL = "http://models.test/v1";

const catalogBody = () =>
  readFileSync(
    join(import.meta.dir, "..", "fixtures", "providers", "models.json"),
    "utf8",
  );

// the recorded catalog for the fake provider, a 502-worthy answer for
// any other host; every call is kept so a test can see what went out
export function fakeFetch(): {
  fetcher: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url, headers });
    if (url === `${PROVIDER_URL}/models`) {
      return new Response(catalogBody(), {
        headers: { "content-type": "application/json" },
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
  fetched: { url: string; headers: Record<string, string> }[];
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
    // the secrets beside admin.key
    secrets?: Record<string, string>;
  } = {},
): Promise<TestApp> {
  const db = memoryDb();
  const now = { value: 1_000_000 };
  const trustProxy = options.trustProxy ?? false;
  const adminPassword =
    options.adminPassword === undefined
      ? "hunter2-test"
      : options.adminPassword;
  const fake = fakeFetch();
  const app = await compose({
    db,
    secret: (name) =>
      name === "admin" ? adminPassword : (options.secrets?.[name] ?? null),
    clock: () => now.value,
    fetcher: options.fetcher ?? fake.fetcher,
    log: () => silent,
    version: VERSION,
    secureCookie: false,
    trustProxy,
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
          // the address as serve() would derive it
          const res = await app.handle(
            req,
            clientAddress(req, address, trustProxy),
          );
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
