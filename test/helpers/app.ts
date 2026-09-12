// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server composed as the binary composes it, over a memory db and a
// fake clock, with the request helper: call(method, path, options) goes
// through the router exactly as Bun.serve would, cookie jar included.

import { type App, compose } from "../../src/server/compose.ts";
import type { Db } from "../../src/server/db/index.ts";
import { silent } from "../../src/server/lib/log.ts";
import { clientAddress } from "../../src/server/web/serve.ts";
import { memoryDb } from "./db.ts";

export const ORIGIN = "http://1ctx.test";
export const VERSION = "v0.0.0-test";

export type TestApp = App & {
  db: Db;
  now: { value: number };
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
  options: { adminPassword?: string | null; trustProxy?: boolean } = {},
): Promise<TestApp> {
  const db = memoryDb();
  const now = { value: 1_000_000 };
  const trustProxy = options.trustProxy ?? false;
  const adminPassword =
    options.adminPassword === undefined
      ? "hunter2-test"
      : options.adminPassword;
  const app = await compose({
    db,
    secret: (name) => (name === "admin" ? adminPassword : null),
    clock: () => now.value,
    log: () => silent,
    version: VERSION,
    secureCookie: false,
    trustProxy,
  });
  return {
    ...app,
    db,
    now,
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
