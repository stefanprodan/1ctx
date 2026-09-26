// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  visualCsp,
  visualDocument,
} from "../../src/server/tools/visual-shell.ts";
import type { ToolsResponse } from "../../src/shared/api/tools.ts";
import { chatApp } from "../helpers/chat.ts";

test("the visual shell authenticates its GET and uses the latest hosts", async () => {
  const chat = await chatApp();
  try {
    const settings: ToolsResponse = await (
      await chat.admin.call("GET", "/api/tools")
    ).json();
    const defaults = settings.visualize.hosts;
    const res = await chat.member.call("GET", "/api/visual", {
      headers: { origin: "https://outside.test" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe(visualCsp(defaults));
    const shell = await res.text();
    expect(shell).toBe(visualDocument());
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const cached = await chat.member.call("GET", "/api/visual", {
      headers: { "if-none-match": etag! },
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect(cached.headers.get("content-security-policy")).toBe(csp);
    expect(cached.headers.get("etag")).toBe(etag);
    const again = await chat.admin.call("GET", "/api/visual");
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe(shell);

    const changed = await chat.admin.call("PATCH", "/api/tools/visualize", {
      body: { hosts: ["https://MIRROR.test:443/"] },
    });
    expect(changed.status).toBe(200);
    const mirrored = await chat.member.call("GET", "/api/visual", {
      headers: { "if-none-match": etag! },
    });
    expect(mirrored.status).toBe(200);
    const mirrorCsp = mirrored.headers.get("content-security-policy")!;
    expect(mirrorCsp).toContain("https://mirror.test");
    for (const host of defaults) expect(mirrorCsp).not.toContain(host);
    expect(mirrored.headers.get("etag")).not.toBe(etag);
    const mirrorEtag = mirrored.headers.get("etag");
    expect(
      (
        await chat.admin.call("PATCH", "/api/tools/visualize", {
          body: { hosts: ["https://mirror.test"] },
        })
      ).status,
    ).toBe(200);
    expect(
      (await chat.member.call("GET", "/api/visual")).headers.get("etag"),
    ).toBe(mirrorEtag);

    expect(
      (
        await chat.admin.call("PATCH", "/api/tools/visualize", {
          body: { hosts: [] },
        })
      ).status,
    ).toBe(200);
    const offline = await chat.member.call("GET", "/api/visual");
    expect(offline.headers.get("content-security-policy")).not.toContain(
      "https:",
    );
    expect(offline.headers.get("content-security-policy")).toContain(
      "script-src 'unsafe-inline' 'unsafe-eval';",
    );
    expect(offline.headers.get("etag")).not.toBe(mirrorEtag);
    expect(await offline.text()).toContain("Idiomorph");
    const anonymous = await chat.app.client().call("GET", "/api/visual", {
      headers: { "if-none-match": offline.headers.get("etag")! },
    });
    expect(anonymous.status).toBe(401);
  } finally {
    await chat.app.shutdown();
  }
});
