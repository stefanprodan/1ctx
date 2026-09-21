// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  ARCHIVE_DEADLINE_MS,
  MAX_ARCHIVE_EXPANDED,
  MAX_ARCHIVE_MEMBERS,
  MAX_ARCHIVE_UPLOAD,
} from "../../src/server/knowledge/limits.ts";
import { MAX_BODY, readBytes } from "../../src/server/lib/body.ts";
import { silent } from "../../src/server/lib/log.ts";
import { router } from "../../src/server/web/router.ts";
import { serve } from "../../src/server/web/serve.ts";
import page from "../fixtures/body.html";
import { testApp } from "../helpers/app.ts";

test("the listener admits upload bytes while JSON routes keep their own caps", async () => {
  expect(MAX_ARCHIVE_UPLOAD).toBe(32 * 1024 * 1024);
  expect(MAX_ARCHIVE_EXPANDED).toBe(64 * 1024 * 1024);
  expect(MAX_ARCHIVE_MEMBERS).toBe(2_000);
  expect(ARCHIVE_DEADLINE_MS).toBe(60_000);
  const app = await testApp();
  const bytesRoute = router({
    resolve: () => ({ principal: null, setCookie: null }),
    trustProxy: false,
    log: silent,
    routes: [
      {
        method: "POST",
        path: "/api/test-bytes",
        policy: "public",
        async handle(req) {
          // A higher route cap makes the listener alone enforce 32 MiB.
          const bytes = await readBytes(req, MAX_ARCHIVE_EXPANDED);
          return Response.json({
            size: bytes.length,
            exact: bytes.every((byte) => byte === 0xa5),
          });
        },
      },
    ],
  });
  const listener = serve({
    hostname: "127.0.0.1",
    port: 0,
    page,
    development: false,
    trustProxy: false,
    socket: app.socket,
    handle: (req, address, upgrade) =>
      new URL(req.url).pathname === "/api/test-bytes"
        ? bytesRoute(req, address, upgrade)
        : app.handle(req, address, upgrade),
  });
  try {
    const origin = listener.server.url.origin;
    for (const size of [20 * 1024 * 1024, MAX_ARCHIVE_UPLOAD]) {
      const res = await fetch(`${origin}/api/test-bytes`, {
        method: "POST",
        headers: {
          origin,
          connection: "close",
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(size).fill(0xa5),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ size, exact: true });
    }
    const oversized = await fetch(`${origin}/api/test-bytes`, {
      method: "POST",
      headers: {
        origin,
        connection: "close",
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array(MAX_ARCHIVE_UPLOAD + 1),
    });
    expect(oversized.status).toBe(413);
    await oversized.text();

    const json = await fetch(`${origin}/api/login`, {
      method: "POST",
      headers: {
        origin,
        connection: "close",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "admin",
        password: "x".repeat(MAX_BODY),
      }),
    });
    expect(json.status).toBe(413);
    expect(await json.json()).toEqual({ error: "body too large" });
  } finally {
    await listener.stop();
    await app.shutdown();
    app.db.close();
  }
});
