// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
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
import { ToolRow } from "../../../src/client/views/admin/ToolRow.tsx";
import {
  editHosts,
  hostsFieldOf,
} from "../../../src/client/views/admin/Tools.model.ts";
import type { ToolsResponse } from "../../../src/shared/api/tools.ts";
import {
  DEFAULT_VISUAL_HOSTS,
  type WebToolSummary,
} from "../../../src/shared/contracts/tool.ts";

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

describe("visual host edits", () => {
  test("adds a host without changing the saved list", () => {
    const hosts = ["https://cdn.example.com"];
    expect(
      editHosts(hosts, { type: "add", host: " HTTPS://CDN.EXAMPLE.COM/ " }),
    ).toEqual(["https://cdn.example.com", "HTTPS://CDN.EXAMPLE.COM/"]);
    expect(hosts).toEqual(["https://cdn.example.com"]);
  });

  test("leaves origin validation and normalization to the server", () => {
    for (const host of [
      "http://cdn.example.com",
      "https://cdn.example.com/path",
      "https://cdn.example.com?q=1",
      "https://cdn.example.com:8443",
      "https://*.example.com",
    ]) {
      expect(editHosts([], { type: "add", host })).toEqual([host]);
    }
    const hosts = Array.from(
      { length: 16 },
      (_, index) => `https://cdn${index}.example.com`,
    );
    expect(
      editHosts(hosts, { type: "add", host: "https://extra.example.com" }),
    ).toHaveLength(17);
  });

  test("removes from the current list, including its last host", () => {
    const hosts = ["https://cdn.example.com", "https://mirror.example.com"];
    expect(
      editHosts(hosts, { type: "remove", host: "https://cdn.example.com" }),
    ).toEqual(["https://mirror.example.com"]);
    expect(editHosts([hosts[0]!], { type: "remove", host: hosts[0]! })).toEqual(
      [],
    );
    expect(hosts).toHaveLength(2);
  });

  test("reset takes a fresh copy of the shared defaults", () => {
    const reset = editHosts([], { type: "reset" });
    expect(reset).toEqual([...DEFAULT_VISUAL_HOSTS]);
    expect(reset).not.toBe(DEFAULT_VISUAL_HOSTS);
    reset.pop();
    expect(editHosts(visual.hosts, { type: "reset" })).toEqual([
      ...DEFAULT_VISUAL_HOSTS,
    ]);
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

  test("a failed Remove or Reset uses the shared form's notice", async () => {
    const save = new Save(async () => {}, 0, hostsFieldOf);
    for (const action of [
      "remove https://cdn.example.com",
      "reset the hosts",
    ]) {
      await save.act(action, async () => {
        throw new ApiError(500, "the server could not save");
      });
      expect(save.notice()).toEqual({
        action,
        error: "the server could not save",
        status: 500,
      });
      expect(save.fieldError("hosts")).toBeNull();
    }
    save.dispose();
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
        hosts: editHosts(visual.hosts, {
          type: "add",
          host: "HTTPS://MIRROR.EXAMPLE.COM/",
        }),
      });
      expect(tools.value?.visualize.hosts).toEqual(canonical);
      await patchTool("visualize", {
        hosts: editHosts(tools.value!.visualize.hosts, {
          type: "remove",
          host: canonical[0]!,
        }),
      });
      expect(tools.value?.visualize.hosts).toEqual([canonical[1]!]);
      await patchTool("visualize", { hosts: [] });
      expect(tools.value?.visualize.hosts).toEqual([]);
      await patchTool("visualize", { hosts: editHosts([], { type: "reset" }) });
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

describe("the visual hosts row", () => {
  test("opens one form with the list, add, remove, reset and disclosure", () => {
    const html = render(<ToolRow tool={visual} open onToggle={() => {}} />);
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toContain('class="rows-list"');
    expect(html).toContain("Allowed hosts");
    expect(html).toContain("https://cdn.example.com");
    expect(html).toContain('aria-label="Remove https://cdn.example.com"');
    expect(html).toContain('name="hosts"');
    expect(html).toContain(">Add</span>");
    expect(html).toContain(">Reset</button>");
    expect(html).toContain(
      "Allowed hosts receive whatever a visual puts in its URLs.",
    );
    expect(html).toContain("Description for agents");
    expect(html).toContain('role="switch"');
    expect(html).not.toContain('type="url"');
  });

  test("an empty list explains inline visuals and still allows Add or Reset", () => {
    const html = render(
      <ToolRow tool={{ ...visual, hosts: [] }} open onToggle={() => {}} />,
    );
    expect(html).toContain("No hosts allowed. Visuals use inline code only.");
    expect(html).toContain(">Add</span>");
    expect(html).toContain(">Reset</button>");
    expect(html).not.toContain(">Remove</button>");
  });

  test("the host form is only on an open visualize row", () => {
    expect(
      render(<ToolRow tool={visual} open={false} onToggle={() => {}} />),
    ).not.toContain("<form");
    expect(
      render(
        <ToolRow
          tool={{
            name: "webfetch",
            description: visual.description,
            parameters: visual.parameters,
            parametersHtml: visual.parametersHtml,
            tokens: visual.tokens,
            when: "web",
            names: false,
            variant: null,
          }}
          open
          onToggle={() => {}}
        />,
      ),
    ).not.toContain("<form");
  });
});
