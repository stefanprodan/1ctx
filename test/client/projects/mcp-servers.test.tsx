// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's MCP servers: the words of a row, who picks which row and
// from which sides, the remove ask, the entity and its writes, and the
// list as drawn for a team's admin, a member and a personal project.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { me } from "../../../src/client/data/me.ts";
import { loadProjectAgents } from "../../../src/client/data/project-agents.ts";
import {
  addProjectMcp,
  loadProjectMcp,
  projectMcpErrorOf,
  projectMcpLists,
  projectMcpOf,
  removeProjectMcp,
  setProjectMcpSide,
} from "../../../src/client/data/project-mcp.ts";
import {
  mcpText,
  openOf,
  PERSONAL_TEXT,
  pickOptions,
  pickValue,
  removable,
  removeAsk,
  rowKind,
  rowLine,
  sideWord,
  TEAM_TEXT,
} from "../../../src/client/views/projects/McpServers.model.ts";
import { McpServers } from "../../../src/client/views/projects/McpServers.tsx";
import type {
  ProjectMcpResponse,
  ProjectMcpServer,
} from "../../../src/shared/api/mcp.ts";
import type { ProjectAgentsResponse } from "../../../src/shared/api/sessions.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import { admin } from "../../helpers/client-fixtures.ts";

const SIDES = {
  choice: "read",
  ceiling: "write",
  side: "read",
  read: true,
} as const;
const flux: ProjectMcpServer = {
  id: "m1",
  name: "flux",
  tools: 3,
  scope: "all",
  ...SIDES,
};
const markets: ProjectMcpServer = {
  id: "m2",
  name: "markets",
  tools: 1,
  scope: "projects",
  ...SIDES,
  projects: 2,
};

const answerOf = (
  servers: ProjectMcpServer[],
  addable: { id: string; name: string }[] = [],
): ProjectMcpResponse => ({ servers, addable });

let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
const calls = clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  me.value = null;
  me.value = admin();
  answer = () => Response.json(answerOf([]));
});

afterEach(() => {
  me.value = undefined;
});

const held = (projectId: string, body: ProjectMcpResponse) => {
  projectMcpLists.value = new Map([[projectId, body]]);
};

describe("the model", () => {
  test("a row says its tools, and This project only on a listed one", () => {
    expect(rowLine(flux, false)).toBe("3 tools");
    expect(rowLine(markets, false)).toBe("1 tool · This project");
    // a personal project's grant is every one's alike
    expect(rowLine(flux, true)).toBe("3 tools");
  });

  test("a team's admin and a personal project's owner pick, a member reads", () => {
    expect(rowKind(true, false)).toBe("admin");
    expect(rowKind(false, false)).toBe("read");
    expect(rowKind(false, true)).toBe("owner");
    expect(rowKind(true, true)).toBe("owner");
  });

  test("only a team admin's listed row has Remove", () => {
    expect(removable("admin", markets)).toBe(true);
    expect(removable("admin", flux)).toBe(false);
    expect(removable("owner", markets)).toBe(false);
    expect(removable("read", markets)).toBe(false);
  });

  test("the sides a row offers: Read with the server's Read, write under a write ceiling", () => {
    const values = (row: Parameters<typeof pickOptions>[0]) =>
      pickOptions(row).map((o) => o.label);
    expect(values(flux)).toEqual(["Off", "Read", "Read and write"]);
    expect(values({ read: true, ceiling: "read" })).toEqual(["Off", "Read"]);
    expect(values({ read: false, ceiling: "write" })).toEqual([
      "Off",
      "Read and write",
    ]);
    expect(values({ read: false, ceiling: "read" })).toEqual(["Off"]);
  });

  test("a choice above a lowered ceiling shows what it gives, an off row says Off", () => {
    expect(pickValue(flux)).toBe("read");
    const capped = {
      ...flux,
      choice: "write",
      ceiling: "read",
      side: "read",
    } as const;
    expect(pickValue(capped)).toBe("read");
    const off = { ...flux, choice: "off", side: "off" } as const;
    expect(pickValue(off)).toBe("off");
    expect(sideWord(off)).toBe("Off");
    expect(sideWord({ side: "write" })).toBe("Read and write");
  });

  test("a form closes when its row goes or is widened", () => {
    expect(openOf(markets, [flux, markets])).toBe(markets);
    expect(openOf(markets, [flux])).toBeNull();
    expect(openOf(markets, [flux, { ...markets, scope: "all" }])).toBeNull();
    expect(openOf(null, [markets])).toBeNull();
  });

  test("removing the last project says it is offered nowhere", () => {
    expect(removeAsk(markets, "finops")).toBe("Remove markets from finops?");
    expect(removeAsk({ ...markets, projects: 1 }, "finops")).toBe(
      "Remove markets from finops? It will be offered in no project.",
    );
  });

  test("the section's text by kind", () => {
    expect(mcpText(true)).toBe(PERSONAL_TEXT);
    expect(mcpText(false)).toBe(TEAM_TEXT);
  });
});

describe("the entity", () => {
  test.serial("a load holds the answer, a 404 drops it", async () => {
    answer = () => Response.json(answerOf([flux]));
    await loadProjectMcp("p2");
    expect(projectMcpOf("p2")?.servers).toEqual([flux]);
    answer = () => Response.json({ error: "no such project" }, { status: 404 });
    await loadProjectMcp("p2");
    expect(projectMcpOf("p2")).toBeNull();
    expect(projectMcpErrorOf("p2")?.status).toBe(404);
  });

  test.serial("an add and a remove keep the list answered", async () => {
    held("p2", answerOf([flux], [{ id: "m2", name: "markets" }]));
    const before = calls.length;
    answer = (url, init) =>
      url.endsWith("/agents")
        ? Response.json({})
        : init?.method === "POST"
          ? Response.json(answerOf([flux, markets]), { status: 201 })
          : Response.json(answerOf([flux], [{ id: "m2", name: "markets" }]));
    await addProjectMcp("p2", "m2");
    expect(calls[before]!.url).toBe("/api/projects/p2/mcp");
    expect(JSON.parse(String(calls[before]!.init?.body))).toEqual({
      serverId: "m2",
    });
    expect(projectMcpOf("p2")?.servers).toEqual([flux, markets]);
    await removeProjectMcp("p2", "m2");
    expect(calls.at(-1)!.url).toBe("/api/projects/p2/mcp/m2");
    expect(calls.at(-1)!.init?.method).toBe("DELETE");
    expect(projectMcpOf("p2")?.addable).toEqual([
      { id: "m2", name: "markets" },
    ]);
  });

  test.serial("a side goes to the team's route or the owner's", async () => {
    held("p2", answerOf([flux]));
    const chosen = answerOf([{ ...flux, choice: "write", side: "write" }]);
    answer = (url) =>
      url.endsWith("/agents") ? Response.json({}) : Response.json(chosen);
    const before = calls.length;
    await setProjectMcpSide("p2", "m1", "write", false);
    expect(calls[before]!.url).toBe("/api/projects/p2/mcp/m1/side");
    expect(calls[before]!.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[before]!.init?.body))).toEqual({
      side: "write",
    });
    expect(projectMcpOf("p2")?.servers[0]?.choice).toBe("write");
    await setProjectMcpSide("p1", "m1", "off", true);
    expect(calls.at(-1)!.url).toBe("/api/profile/project/mcp/m1/side");
  });

  test.serial(
    "an older pick's answer arriving last never undoes a newer one",
    async () => {
      const agentsBody: ProjectAgentsResponse = {
        agents: [],
        startsOn: null,
        capabilities: [],
        servers: [],
        skills: {},
        credentials: [],
        repos: [],
      };
      answer = () => Response.json(agentsBody);
      await loadProjectAgents("p2");
      held("p2", answerOf([flux, markets]));
      let release: () => void = () => {};
      const first = answerOf([
        { ...flux, choice: "off", side: "off" },
        markets,
      ]);
      const second = answerOf([
        { ...flux, choice: "off", side: "off" },
        { ...markets, choice: "write", side: "write" },
      ]);
      answer = (url) => {
        if (url.endsWith("/agents")) return Response.json(agentsBody);
        if (url.includes("/m1/")) {
          return new Promise<Response>((done) => {
            release = () => done(Response.json(first));
          });
        }
        return Response.json(second);
      };
      const before = calls.length;
      const slow = setProjectMcpSide("p2", "m1", "off", false);
      await setProjectMcpSide("p2", "m2", "write", false);
      release();
      await slow;
      expect(projectMcpOf("p2")?.servers[1]?.choice).toBe("write");
      // both writes changed the offer, so both read the agents again
      const agents = calls
        .slice(before)
        .filter((c) => c.url.endsWith("/agents")).length;
      expect(agents).toBe(2);
    },
  );

  test.serial("a refused side reads the list again", async () => {
    held("p2", answerOf([flux]));
    answer = (_url, init) =>
      init?.method === "PUT"
        ? Response.json({ error: "side may be at most read" }, { status: 400 })
        : Response.json(answerOf([{ ...flux, ceiling: "read" }]));
    await expect(
      setProjectMcpSide("p2", "m1", "write", false),
    ).rejects.toThrow();
    expect(calls.at(-1)!.init?.method ?? "GET").toBe("GET");
    expect(projectMcpOf("p2")?.servers[0]?.ceiling).toBe("read");
  });

  test.serial("a refused add reads the list again", async () => {
    held("p2", answerOf([flux], [{ id: "m2", name: "markets" }]));
    answer = (_url, init) =>
      init?.method === "POST"
        ? Response.json({ error: "no such MCP server" }, { status: 404 })
        : Response.json(answerOf([flux]));
    await expect(addProjectMcp("p2", "m2")).rejects.toThrow();
    expect(calls.at(-1)!.url).toBe("/api/projects/p2/mcp");
    expect(calls.at(-1)!.init?.method ?? "GET").toBe("GET");
    // the stale row is gone from Add
    expect(projectMcpOf("p2")?.addable).toEqual([]);
  });

  test.serial("a refused remove reads the list again", async () => {
    held("p2", answerOf([flux, markets]));
    answer = (_url, init) =>
      init?.method === "DELETE"
        ? Response.json(
            { error: "the MCP server is offered in every project" },
            { status: 409 },
          )
        : Response.json(answerOf([flux, { ...markets, scope: "all" }]));
    await expect(removeProjectMcp("p2", "m2")).rejects.toThrow();
    expect(calls.at(-1)!.url).toBe("/api/projects/p2/mcp");
    expect(projectMcpOf("p2")?.servers[1]?.scope).toBe("all");
  });
});

describe("the project's agents", () => {
  test.serial("a write reads the shown project's agents again", async () => {
    const agentsBody: ProjectAgentsResponse = {
      agents: [],
      startsOn: null,
      capabilities: [],
      servers: [],
      skills: {},
      credentials: [],
      repos: [],
    };
    answer = (url) =>
      url.endsWith("/agents")
        ? Response.json(agentsBody)
        : Response.json(answerOf([flux, markets]), { status: 201 });
    await loadProjectAgents("p2");
    held("p2", answerOf([flux], [{ id: "m2", name: "markets" }]));
    const before = calls.length;
    await addProjectMcp("p2", "m2");
    expect(calls.slice(before).map((c) => c.url)).toEqual([
      "/api/projects/p2/mcp",
      "/api/projects/p2/agents",
    ]);
    // another project's write leaves the shown one's agents alone
    held("p3", answerOf([], [{ id: "m2", name: "markets" }]));
    const next = calls.length;
    await addProjectMcp("p3", "m2");
    expect(calls.slice(next).map((c) => c.url)).toEqual([
      "/api/projects/p3/mcp",
    ]);
  });
});

describe("the list", () => {
  test.serial(
    "a team's admin: every row picks and links, a listed one removes",
    () => {
      held("p2", answerOf([flux, markets], [{ id: "m3", name: "github" }]));
      const html = render(
        <McpServers
          projectId="p2"
          projectName="finops"
          personal={false}
          section
          admin
        />,
      );
      expect(html).toContain(">MCP Servers<");
      expect(html).toContain(TEAM_TEXT);
      expect(html).not.toContain("All team projects");
      expect(html).toContain(">3 tools<");
      expect(html).toContain("1 tool · This project");
      expect(html).toContain('href="/admin/config/mcp/flux"');
      expect(html).toContain('href="/admin/config/mcp/markets"');
      // one dropdown per row, showing the pick
      expect(html.match(/aria-label="Side of /g)).toHaveLength(2);
      expect(html.match(/select-trigger-small/g)).toHaveLength(2);
      expect(html.match(/select-label cut">Read</g)).toHaveLength(2);
      // only the listed row has More, with Remove in it; the other keeps
      // its room so the picks line up
      expect(html.match(/aria-label="More for /g)).toHaveLength(1);
      expect(html).toContain('aria-label="More for markets"');
      expect(html.match(/mcp-servers-gap/g)).toHaveLength(1);
      expect(html).toContain("Add server");
    },
  );

  test.serial("nothing to add hides Add server", () => {
    held("p2", answerOf([flux, markets]));
    const html = render(
      <McpServers
        projectId="p2"
        projectName="finops"
        personal={false}
        section={false}
        admin
      />,
    );
    expect(html).not.toContain("Add server");
    // the admin page's card counts its rows
    expect(html).toContain("setting-count");
  });

  test.serial("a member reads the rows with no control", () => {
    held("p2", answerOf([flux, markets]));
    const html = render(
      <McpServers
        projectId="p2"
        projectName="finops"
        personal={false}
        section
        admin={false}
      />,
    );
    expect(html).toContain("1 tool · This project");
    expect(html).not.toContain("Side of");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Add server");
    expect(html).not.toContain("More for");
    // each row says what the project chose, an off one too, in the
    // pick's column
    expect(html).toContain('<span class="mcp-servers-word">Read<');
  });

  test.serial("an off row stays, saying Off", () => {
    held("p2", answerOf([{ ...flux, choice: "off", side: "off" }]));
    const read = render(
      <McpServers
        projectId="p2"
        projectName="finops"
        personal={false}
        section
        admin={false}
      />,
    );
    expect(read).toContain("flux");
    expect(read).toContain(">Off<");
    const picked = render(
      <McpServers
        projectId="p2"
        projectName="finops"
        personal={false}
        section
        admin
      />,
    );
    expect(picked).toContain('select-label cut">Off<');
  });

  test.serial(
    "a personal project's owner picks, with no link and no remove",
    () => {
      held("p1", answerOf([{ ...flux, ceiling: "read" }]));
      const html = render(
        <McpServers
          projectId="p1"
          projectName="admin"
          personal
          section
          admin={false}
        />,
      );
      expect(html).toContain(PERSONAL_TEXT);
      expect(html).toContain("3 tools");
      expect(html).not.toContain("All team projects");
      expect(html).toContain('aria-label="Side of flux"');
      // a read ceiling hides Read and write
      expect(html).not.toContain("Read and write");
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("More for");
      expect(html).not.toContain("mcp-servers-gap");
    },
  );

  test.serial("an empty list says so", () => {
    held("p2", answerOf([]));
    const html = render(
      <McpServers
        projectId="p2"
        projectName="finops"
        personal={false}
        section
        admin={false}
      />,
    );
    expect(html).toContain("No MCP Servers.");
  });
});
