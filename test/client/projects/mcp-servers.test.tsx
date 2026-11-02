// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's MCP servers: the words of a row, who edits which row, the
// remove ask, the entity and its writes, and the list as drawn for a
// team's admin, a member and a personal project.

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
} from "../../../src/client/data/project-mcp.ts";
import {
  mcpText,
  openOf,
  PERSONAL_TEXT,
  removeAsk,
  rowKind,
  rowLine,
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

const flux: ProjectMcpServer = {
  id: "m1",
  name: "flux",
  tools: 3,
  scope: "all",
};
const markets: ProjectMcpServer = {
  id: "m2",
  name: "markets",
  tools: 1,
  scope: "projects",
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
  test("a row says its tools and every project or this one", () => {
    expect(rowLine(flux)).toBe("3 tools · All projects");
    expect(rowLine(markets)).toBe("1 tool · This project");
  });

  test("only a team's admin edits, and an all row only links", () => {
    expect(rowKind(markets, true, false)).toBe("edit");
    expect(rowKind(flux, true, false)).toBe("link");
    expect(rowKind(markets, false, false)).toBe("read");
    expect(rowKind(flux, false, false)).toBe("read");
    // a personal project lists only all servers, read-only for everyone
    expect(rowKind(flux, true, true)).toBe("read");
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
      servers: {},
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
  test.serial("a team's admin: a listed row opens, an all row links", () => {
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
    expect(html).toContain("3 tools · All projects");
    expect(html).toContain("1 tool · This project");
    expect(html).toContain('href="/admin/config/mcp/flux"');
    expect(html.match(/class="rows-line rows-button"/g)).toHaveLength(1);
    expect(html).toContain("Add server");
  });

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
    expect(html).not.toContain("rows-button");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Add server");
  });

  test.serial("a personal project lists its all servers, read-only", () => {
    held("p1", answerOf([flux]));
    const html = render(
      <McpServers projectId="p1" projectName="admin" personal section admin />,
    );
    expect(html).toContain(PERSONAL_TEXT);
    expect(html).toContain("3 tools · All projects");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("rows-button");
  });

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
