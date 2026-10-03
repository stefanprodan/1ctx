// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The listener serves the manifest's icons at the fixed paths the
// manifest names, with no login, and every other path the page.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { serve } from "../../../src/server/web/serve.ts";
import page from "../../fixtures/body.html";
import { testApp } from "../../helpers/app.ts";

const CLIENT = join(import.meta.dir, "../../../src/client");
const ICONS = {
  "/icon-192.png": join(CLIENT, "icon-192.png"),
  "/icon-maskable-512.png": join(CLIENT, "icon-maskable-512.png"),
};

test("the manifest's icons are served beside the page", async () => {
  const app = await testApp();
  const listener = serve({
    hostname: "127.0.0.1",
    port: 0,
    page,
    files: ICONS,
    development: false,
    trustProxy: false,
    socket: app.socket,
    handle: app.handle,
  });
  try {
    const origin = listener.server.url.origin;
    for (const [path, file] of Object.entries(ICONS)) {
      const res = await fetch(`${origin}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(
        await Bun.file(file).bytes(),
      );
      const head = await fetch(`${origin}${path}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("image/png");
      expect(head.headers.get("etag")).toBeTruthy();
      await head.arrayBuffer();
    }
    const other = await fetch(`${origin}/icon-1024.png`);
    expect(other.headers.get("content-type")).toStartWith("text/html");
    await other.text();
  } finally {
    await listener.stop();
    await app.shutdown();
    app.db.close();
  }
});
