// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError } from "../../../src/client/data/api.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  limits,
  loadTools,
  patchTool,
  tools,
  toolsError,
} from "../../../src/client/data/tools.ts";
import { Save } from "../../../src/client/lib/save.ts";
import {
  defaultHosts,
  hostsCount,
  hostsFieldOf,
  hostsOf,
} from "../../../src/client/views/admin/Tools.model.ts";
import type { ToolsResponse } from "../../../src/shared/api/tools.ts";
import {
  DEFAULT_VISUAL_HOSTS,
  type WebToolSummary,
} from "../../../src/shared/contracts/tool.ts";
import { parseVisualHosts } from "../../../src/shared/visual.ts";

const visual: WebToolSummary = {
  name: "visualize",
  description: "Draw a visual in the chat.",
  parameters: { type: "object", properties: {} },
  parametersHtml: '<pre class="md-pre">{}</pre>',
  tokens: 120,
  enabled: true,
  hosts: ["https://cdn.example.com"],
  updatedAt: 0,
};

const response = (hosts: string[]): ToolsResponse => ({
  builtin: [],
  access: { mode: "all", domains: [], updatedAt: 0 },
  visualize: { ...visual, hosts },
  search: {
    provider: null,
    keys: { exa: false, firecrawl: false, tavily: false },
  },
});

describe("the visual hosts box", () => {
  test("reads lines as origins, trimmed, deduped and sorted", () => {
    expect(
      hostsOf(" HTTPS://Z.TEST/ \n\nhttps://a.test\nhttps://z.test:443\n"),
    ).toEqual({ hosts: ["https://a.test", "https://z.test"] });
    expect(hostsOf("")).toEqual({ hosts: [] });
    expect(hostsOf("\n  \n")).toEqual({ hosts: [] });
  });

  test("names the first line that is not an origin", () => {
    expect(hostsOf("https://a.test\nhttp://b.test")).toEqual({
      error: "Line 2, http://b.test, is not an HTTPS origin.",
    });
    for (const line of [
      "https://a.test/path",
      "https://a.test:8443",
      "https://*.test",
      "https://user@a.test",
      "cdn.example.com",
    ]) {
      expect(hostsOf(line)).toEqual({
        error: `Line 1, ${line}, is not an HTTPS origin.`,
      });
    }
  });

  test("caps the list the server caps", () => {
    const lines = Array.from({ length: 17 }, (_, i) => `https://h${i}.test`);
    expect(hostsOf(lines.slice(0, 16).join("\n"))).toMatchObject({
      hosts: expect.any(Array),
    });
    expect(hostsOf(lines.join("\n"))).toEqual({ error: "At most 16 hosts." });
    // a repeat counts once
    expect(parseVisualHosts([...lines.slice(0, 16), lines[0]!])).toMatchObject({
      ok: true,
    });
  });

  test("counts the lines that hold something", () => {
    expect(hostsCount("")).toBe(0);
    expect(hostsCount("https://a.test\n\n  \nhttps://b.test\n")).toBe(2);
    expect(hostsCount("not an origin")).toBe(1);
  });

  test("knows the defaults, in the stored order", () => {
    expect(defaultHosts([...DEFAULT_VISUAL_HOSTS])).toBe(true);
    expect(defaultHosts([...DEFAULT_VISUAL_HOSTS].reverse())).toBe(false);
    expect(defaultHosts(DEFAULT_VISUAL_HOSTS.slice(1))).toBe(false);
    expect(defaultHosts([])).toBe(false);
  });

  test("the server's host refusals name the host field", async () => {
    for (const message of [
      "hosts must be a list of at most 16 HTTPS origins",
      "hosts must be HTTPS origins without a path, query or custom port",
      "hosts must be valid HTTPS origins",
    ]) {
      expect(hostsFieldOf(message)).toBe("hosts");
      const save = new Save(
        async () => {
          throw new ApiError(400, message);
        },
        0,
        hostsFieldOf,
      );
      await save.run(null);
      expect(save.status.value).toEqual({
        error: message,
        field: "hosts",
        status: 400,
      });
      expect(save.fieldError("hosts")).not.toBeNull();
      expect(save.notice()).toBeNull();
      save.dispose();
    }
    expect(hostsFieldOf("the server could not save")).toBeUndefined();
  });
});

describe("the visual hosts entity", () => {
  const realFetch = globalThis.fetch;
  let previous: {
    me: typeof me.value;
    tools: typeof tools.value;
    limits: typeof limits.value;
    error: typeof toolsError.value;
  };

  beforeEach(() => {
    previous = {
      me: me.value,
      tools: tools.value,
      limits: limits.value,
      error: toolsError.value,
    };
    me.value = {
      id: "visual-admin",
      username: "admin",
      fullName: "Admin",
      role: "admin",
      mustChangePassword: false,
    };
    tools.value = response(visual.hosts);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    me.value = previous.me;
    tools.value = previous.tools;
    limits.value = previous.limits;
    toolsError.value = previous.error;
  });

  test.serial(
    "each edit PATCHes hosts and keeps the server's answer",
    async () => {
      const bodies: unknown[] = [];
      const canonical = [
        "https://cdn.example.com",
        "https://mirror.example.com",
      ];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        expect(url).toBe("/api/tools/visualize");
        expect(init?.method).toBe("PATCH");
        const body = JSON.parse(init?.body as string);
        bodies.push(body);
        return Response.json(
          response(bodies.length === 1 ? canonical : body.hosts),
        );
      }) as unknown as typeof fetch;

      await patchTool("visualize", {
        hosts: ["https://cdn.example.com", "HTTPS://MIRROR.EXAMPLE.COM/"],
      });
      expect(tools.value?.visualize.hosts).toEqual(canonical);
      await patchTool("visualize", { hosts: [canonical[1]!] });
      expect(tools.value?.visualize.hosts).toEqual([canonical[1]!]);
      await patchTool("visualize", { hosts: [] });
      expect(tools.value?.visualize.hosts).toEqual([]);
      await patchTool("visualize", { hosts: [...DEFAULT_VISUAL_HOSTS] });
      expect(tools.value?.visualize.hosts).toEqual([...DEFAULT_VISUAL_HOSTS]);
      expect(bodies).toEqual([
        { hosts: ["https://cdn.example.com", "HTTPS://MIRROR.EXAMPLE.COM/"] },
        { hosts: ["https://mirror.example.com"] },
        { hosts: [] },
        { hosts: [...DEFAULT_VISUAL_HOSTS] },
      ]);
    },
  );

  test.serial(
    "a refused edit keeps the saved hosts and server words",
    async () => {
      const message = "hosts must be valid HTTPS origins";
      globalThis.fetch = Object.assign(
        async () => Response.json({ error: message }, { status: 400 }),
        { preconnect: realFetch.preconnect },
      );
      await expect(
        patchTool("visualize", { hosts: ["invalid"] }),
      ).rejects.toMatchObject({ message, status: 400 });
      expect(tools.value?.visualize.hosts).toEqual(visual.hosts);
    },
  );

  test.serial("an older load cannot restore removed hosts", async () => {
    let release!: (response: Response) => void;
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/tools") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (url === "/api/limits") return Response.json({ limits: [] });
      if (url === "/api/tools/visualize") return Response.json(response([]));
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const loading = loadTools();
    await patchTool("visualize", { hosts: [] });
    release(Response.json(response(visual.hosts)));
    await loading;
    expect(tools.value?.visualize.hosts).toEqual([]);
  });
});
