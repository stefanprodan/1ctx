// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The MCP pages' model: the change line, the timeout in seconds, the
// instructions box trimmed to its lines, the agent form's preview from
// the rows loaded; the entity that loads the list with the keys and
// folds a write back; and the list and a server's tabs rendered.

import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import {
  addServer,
  callTimeoutMs,
  deleteServer,
  keys,
  loadedAt,
  loadMcp,
  loadServerUsage,
  patchServer,
  refreshServer,
  servers,
  serversError,
} from "../../../src/client/data/mcp.ts";
import { me } from "../../../src/client/data/me.ts";
import { promptPreview } from "../../../src/client/views/admin/AgentPage.model.ts";
import { listed } from "../../../src/client/views/admin/Agents.model.ts";
import {
  changeLine,
  deleteAsk,
  deleteLine,
  grantWords,
  instructionsBox,
  instructionsLine,
  mcpFieldOf,
  offerOf,
  offerSides,
  personalForKey,
  personalHint,
  personalProblem,
  projectsBody,
  projectsProblem,
  reachForKey,
  reachHint,
  reachOf,
  sidesLine,
  timeoutMs,
  timeoutProblem,
  timeoutText,
} from "../../../src/client/views/admin/Mcp.model.ts";
import { McpList } from "../../../src/client/views/admin/McpList.tsx";
import { McpDrafts } from "../../../src/client/views/admin/McpPage.state.ts";
import { McpPage, mcpTabOf } from "../../../src/client/views/admin/McpPage.tsx";
import { ToolParams } from "../../../src/client/views/admin/ToolParams.tsx";
import { onWords } from "../../../src/client/views/directory/Directory.model.ts";
import type {
  McpServerSummary,
  McpToolSummary,
} from "../../../src/shared/contracts/mcp.ts";
import {
  MAX_INSTRUCTIONS_BLOCK,
  MAX_SCHEMAS_BYTES,
} from "../../../src/shared/mcp.ts";

import { clientFetch } from "../../helpers/client-fetch.ts";
import { admin as adminFixture } from "../../helpers/client-fixtures.ts";

const admin = adminFixture();

const HOUR = 3_600_000;
const now = 1_789_000_000_000;

const tool = (
  name: string,
  description = `${name} does things.`,
): McpToolSummary => ({
  name,
  wireName: `mcp__flux__${name}`,
  unusable: null,
  description,
  parameters: { type: "object", properties: {} },
  schemaJson: '{"type":"object","properties":{}}',
  parametersHtml: "<pre>{}</pre>",
});

const server = (changes: Partial<McpServerSummary> = {}): McpServerSummary => ({
  id: "m1",
  name: "flux",
  url: "http://flux.test/mcp",
  keyName: null,
  hasKey: false,
  read: true,
  write: false,
  instructionsOn: true,
  timeoutMs: null,
  readPatterns: ["get_*", "trace_*"],
  writePatterns: [],
  excludedPatterns: ["install_*"],
  scope: "all",
  projects: [],
  personal: "read",
  on: { projects: [], personal: 0 },
  serverName: "flux-operator-mcp",
  serverVersion: "1.0.0",
  protocolVersion: "2026-07-28",
  instructions: "Workflow:\n- call get_flux_instance first.",
  checkedAt: now - 2 * HOUR,
  lastChange: null,
  refreshError: null,
  refreshFailedAt: null,
  createdAt: now - 3 * HOUR,
  tools: [
    tool("get_flux_instance"),
    tool("trace_kubernetes_resource"),
    tool("reconcile_flux_resource"),
    tool("install_flux_instance"),
    { ...tool("a.b"), wireName: null },
  ],
  ...changes,
});
const flux = server();

let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  me.value = admin;
  servers.value = null;
  serversError.value = null;
  keys.value = [];
  loadedAt.value = null;
});

describe("the model", () => {
  test.serial("the last change as one line", () => {
    expect(changeLine(null, now)).toBe("");
    expect(
      changeLine(
        {
          at: now - 2 * HOUR,
          added: ["a"],
          removed: ["b"],
          changed: ["c", "d"],
          instructions: true,
        },
        now,
      ),
    ).toBe("2h ago: 1 tool added, 1 removed, 2 changed, instructions changed");
    expect(
      changeLine(
        {
          at: now,
          added: [],
          removed: [],
          changed: ["c"],
          instructions: false,
        },
        now,
      ),
    ).toBe("0s ago: 1 tool changed");
  });

  test.serial("the sides as one pick, write alone as read and write", () => {
    expect(offerOf(false, false)).toBe("off");
    expect(offerOf(true, false)).toBe("read");
    expect(offerOf(true, true)).toBe("write");
    expect(offerOf(false, true)).toBe("write");
    expect(offerSides("off")).toEqual({ read: false, write: false });
    expect(offerSides("read")).toEqual({ read: true, write: false });
    expect(offerSides("write")).toEqual({ read: true, write: true });
  });

  test.serial("the timeout in seconds, empty for the limits' value", () => {
    expect(timeoutText(null)).toBe("");
    expect(timeoutText(90_000)).toBe("90");
    expect(timeoutMs("")).toBeNull();
    expect(timeoutMs(" 2.5 ")).toBe(2500);
    expect(timeoutProblem("")).toBeNull();
    expect(timeoutProblem("90")).toBeNull();
    expect(timeoutProblem("abc")).toBe(
      "The call timeout needs a number of seconds",
    );
    expect(timeoutProblem("0.5")).toBe(
      "The call timeout must be from 1 to 3600 seconds",
    );
    expect(timeoutProblem("3601")).toBe(
      "The call timeout must be from 1 to 3600 seconds",
    );
  });

  test.serial(
    "the instructions box shows the block, trimmed past 12 lines",
    () => {
      const short = instructionsBox("flux", "one\ntwo", false);
      expect(short.text).toBe(
        '  <server name="flux">\n    one\n    two\n  </server>',
      );
      expect(short.cut).toBe(false);
      expect(short.count).toBe(short.text.length);
      const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
      const folded = instructionsBox("flux", long, false);
      expect(folded.cut).toBe(true);
      expect(folded.text.split("\n")).toHaveLength(12);
      expect(instructionsBox("flux", long, true).text.split("\n")).toHaveLength(
        22,
      );
    },
  );

  test.serial("the agent form's preview from the rows loaded", () => {
    const docs = server({
      id: "m2",
      name: "docs",
      write: true,
      instructions: "x".repeat(MAX_INSTRUCTIONS_BLOCK),
      readPatterns: [],
    });
    // every server on its own switches, whichever projects choose it
    const preview = promptPreview([flux, docs]);
    expect(preview.line).toMatch(
      /^Instructions in the prompt: [\d,]+ of 32,000 characters, from flux$/,
    );
    expect(preview.warnings).toEqual(["docs left out: over the 32,000 cap"]);
    expect(preview.text).toContain('<server name="flux">');
    expect(preview.text).not.toContain('name="docs"');
    const huge = server({
      id: "m3",
      name: "huge",
      instructions: "huge instructions",
      tools: [
        {
          ...tool("get_huge"),
          wireName: "mcp__huge__get_huge",
          schemaJson: JSON.stringify({
            type: "object",
            enum: ["x".repeat(MAX_SCHEMAS_BYTES)],
          }),
        },
      ],
    });
    const schemaPreview = promptPreview([flux, huge]);
    expect(schemaPreview.warnings).toEqual([
      "huge left out: its tools are over the 1 MB cap",
    ]);
    expect(schemaPreview.line).toEndWith("from flux");
    // the switch off on the only server: no line, no warning
    const quiet = promptPreview([server({ instructionsOn: false })]);
    expect(quiet).toEqual({
      line: "",
      warnings: [],
      text: "",
      count: 0,
      from: [],
    });
    // a server with both switches off: nothing offered
    expect(promptPreview([{ ...flux, read: false }]).line).toBe("");
  });

  test.serial("a refusal's field", () => {
    expect(mcpFieldOf("name is invalid")).toBe("name");
    expect(mcpFieldOf("an MCP server named flux exists")).toBe("name");
    expect(mcpFieldOf("keyName must start with mcp-")).toBe("keyName");
    expect(mcpFieldOf("readPatterns has an invalid pattern")).toBe(
      "readPatterns",
    );
    expect(mcpFieldOf("the MCP server refused the key")).toBe("keyName");
    expect(mcpFieldOf("the MCP server is offline")).toBe("url");
    expect(mcpFieldOf("MCP request timed out")).toBe("url");
    expect(mcpFieldOf("an agent uses the MCP server")).toBeUndefined();
    expect(mcpFieldOf("the MCP server is refreshing")).toBeUndefined();
    expect(mcpFieldOf("a server with a key needs personal")).toBe("personal");
    expect(mcpFieldOf("personal must be off, read or write")).toBe("personal");
  });

  test.serial("the agent's skills: the listed ones", () => {
    const both = ["s1", "s2"];
    expect(listed(both, (id) => id, null)).toBe(both);
    expect(listed(both, (id) => id, [{ id: "s2" }])).toEqual(["s2"]);
  });
});

describe("the entity", () => {
  test.serial(
    "loads the rows with the keys and when they were read, and folds a write back",
    async () => {
      const calls: string[] = [];
      answer = (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/mcp" && (init?.method ?? "GET") === "GET") {
          return Response.json({
            servers: [flux],
            keys: ["mcp-github"],
            callTimeoutMs: 20_000,
            loadedAt: now,
          });
        }
        if (url === "/api/mcp/m1" && init?.method === "PATCH") {
          return Response.json({ server: server({ write: true }) });
        }
        if (url === "/api/mcp/m1/refresh") {
          return Response.json({
            server: server({ serverVersion: "2.0.0", checkedAt: now }),
          });
        }
        if (url === "/api/mcp" && init?.method === "POST") {
          return Response.json({ server: server({ id: "m2", name: "docs" }) });
        }
        if (url === "/api/mcp/m2" && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: "nope" }, { status: 500 });
      };
      await loadMcp();
      expect(servers.value).toEqual([flux]);
      expect(keys.value).toEqual(["mcp-github"]);
      expect(callTimeoutMs.value).toBe(20_000);
      expect(loadedAt.value).toBe(now);
      await patchServer("m1", { write: true });
      expect(servers.value?.[0]?.write).toBe(true);
      await refreshServer("m1");
      expect(servers.value?.[0]?.serverVersion).toBe("2.0.0");
      await addServer({
        name: "docs",
        url: "http://docs.test/mcp",
        keyName: null,
        read: true,
        write: false,
        instructionsOn: true,
        timeoutMs: null,
        readPatterns: [],
        writePatterns: [],
        excludedPatterns: [],
      });
      expect(servers.value?.map((s) => s.name)).toEqual(["docs", "flux"]);
      await deleteServer("m2");
      expect(servers.value?.map((s) => s.name)).toEqual(["flux"]);
      expect(calls[0]).toBe("GET /api/mcp");
    },
  );

  test.serial("a write supersedes a load in flight", async () => {
    let finishLoad!: (response: Response) => void;
    let finishWrite!: (response: Response) => void;
    const loadResponse = new Promise<Response>((resolve) => {
      finishLoad = resolve;
    });
    const writeResponse = new Promise<Response>((resolve) => {
      finishWrite = resolve;
    });
    answer = (_url, init) =>
      init?.method === "PATCH" ? writeResponse : loadResponse;
    const loading = loadMcp();
    const writing = patchServer("m1", { write: true });
    finishLoad(
      Response.json({
        servers: [flux],
        keys: [],
        callTimeoutMs: 20_000,
        loadedAt: now - HOUR,
      }),
    );
    await loading;
    expect(servers.value).toBeNull();
    finishWrite(Response.json({ server: server({ write: true }) }));
    await writing;
    expect(servers.value?.[0]?.write).toBe(true);
  });

  test.serial("a load that fails is the page's error", async () => {
    answer = () => Response.json({ error: "down" }, { status: 503 });
    await loadMcp();
    expect(servers.value).toBeNull();
    expect(serversError.value).toEqual({ words: "down", status: 503 });
  });
});

describe("the list", () => {
  test.serial("a row per server: the URL, its grants and its sides", () => {
    servers.value = [flux];
    keys.value = ["mcp-github"];
    const html = render(<McpList />);
    expect(html).toContain('href="/admin/config/mcp/flux"');
    expect(html).toContain(flux.url);
    expect(html).toContain("All teams · personal read");
    expect(html).toContain("2 read · write off");
    expect(html).toContain('href="/admin/config/mcp?new"');
    expect(html).toContain("mcp-github.key");
    expect(html).toContain("unused");
  });

  test.serial("the sides: a count per side on, off for the other", () => {
    // reconcile_flux_resource is written by default, install_ excluded
    expect(sidesLine(server({ write: true }))).toBe("2 read · 1 write");
    expect(sidesLine(server({ read: false }))).toBe("read off · write off");
  });

  test.serial("a failed refresh takes the URL's place, in red", () => {
    servers.value = [
      server({ refreshError: "offline", refreshFailedAt: Date.now() - 60_000 }),
    ];
    const html = render(<McpList />);
    expect(html).toContain("refresh failed 1m ago");
  });
});

describe("a server's page", () => {
  test.serial("the tab is the step after the name", () => {
    expect(mcpTabOf("/admin/config/mcp/flux")).toBe("general");
    expect(mcpTabOf("/admin/config/mcp/flux/tools")).toBe("tools");
    expect(mcpTabOf("/admin/config/mcp/tools")).toBe("general");
  });

  test.serial("General: the facts, the endpoint, where it is on", () => {
    servers.value = [
      server({
        on: { projects: [{ id: "p2", name: "finops" }], personal: 3 },
      }),
    ];
    path.value = "/admin/config/mcp/flux";
    const html = render(<McpPage params={{ name: "flux" }} />);
    expect(html).toContain("flux-operator-mcp 1.0.0");
    expect(html).toContain("2026-07-28");
    expect(html).toContain(`value="${flux.url}"`);
    expect(html).toContain(">On in<");
    expect(html).toContain('href="/admin/access/projects/p2"');
    expect(html).toContain("3 personal projects");
    expect(html).toContain("On in finops, 3 personal projects.");
    expect(html).not.toContain("Used by");
    // no agent holds a server, so Delete only asks
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Delete</);
    expect(html).toContain(">Personal projects<");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Read</);
    expect(html).toContain('aria-label="Instructions on"');
    expect(html).toContain(instructionsLine(true));
  });

  test.serial("General: a failed refresh over the tabs, no agents", () => {
    servers.value = [
      server({
        instructions: "",
        refreshError: "discovery failed",
        refreshFailedAt: Date.now() - 60_000,
        checkedAt: Date.now() - 2 * HOUR,
      }),
    ];
    path.value = "/admin/config/mcp/flux";
    const html = render(<McpPage params={{ name: "flux" }} />);
    expect(html).toContain("Discovery failed. Last refresh 1m ago.");
    expect(html).toContain("The server sent no instructions.");
    expect(html).toContain("On in no project.");
    expect(html).not.toContain(">On in<");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Delete</);
  });

  test.serial("General: long instructions fold with Show all", () => {
    servers.value = [
      server({
        instructions: Array.from({ length: 20 }, (_, i) => `line ${i}`).join(
          "\n",
        ),
      }),
    ];
    path.value = "/admin/config/mcp/flux";
    const html = render(<McpPage params={{ name: "flux" }} />);
    expect(html).toMatch(/fold-more">[^<]*<button[^>]*>Show all \d+ lines</);
  });

  test.serial(
    "Tools: the matchers with what they decide, each tool's side",
    () => {
      servers.value = [server({ readPatterns: ["get_*", "trace_*", "gte_*"] })];
      path.value = "/admin/config/mcp/flux/tools";
      const html = render(<McpPage params={{ name: "flux" }} />);
      // get_* decides one tool, a typo matches none and is marked
      expect(html).toMatch(
        /get_\*<\/span><span class="mcp-page-chip-count">1</,
      );
      expect(html).toContain("mcp-page-chip-none");
      expect(html).toContain("gte_* matches no tool");
      expect(html).toContain("by get_*");
      expect(html).toContain("by default");
      expect(html).toContain("by install_*");
      // a name too long for the wire cannot be picked
      expect(html).toContain("Unusable 1");
      expect(html).toContain("Pick every tool shown");
    },
  );

  test.serial(
    "the aside has its last 30 days and its most called tools",
    async () => {
      // a sign-in drops every answer kept
      me.value = null;
      me.value = admin;
      servers.value = [flux];
      path.value = "/admin/config/mcp/flux";
      const page = () => render(<McpPage params={{ name: "flux" }} />);
      expect(page()).toContain("Loading");
      answer = () =>
        Response.json({
          since: 0,
          until: 1,
          calls: 12,
          failed: 2,
          tools: [{ name: "get_flux_instance", calls: 10 }],
        });
      await loadServerUsage("m1");
      expect(page()).toMatch(/Calls[\s\S]*?12/);
      expect(page()).toMatch(/get_flux_instance[\s\S]*?10/);
      expect(page()).toContain('href="/admin/monitor/usage"');
      answer = () => Response.json({ error: "down" }, { status: 503 });
      await loadServerUsage("m1");
      expect(page()).toContain("Did not load.");
    },
  );
});

describe("the drafts", () => {
  test.serial("saving Access keeps a timeout typed and not saved", () => {
    const d = McpDrafts.of(flux);
    d.timeout.value = "30";
    d.resetAccess(server({ write: true }));
    expect(d.timeout.value).toBe("30");
    expect(d.write.value).toBe(true);
  });

  test.serial("Access saves what changed in one body", () => {
    const d = McpDrafts.of(flux);
    expect(d.accessDirty(flux)).toBe(false);
    expect(d.accessBody(flux)).toEqual({});
    d.personal.value = "off";
    expect(d.accessBody(flux)).toEqual({ personal: "off" });
    d.write.value = true;
    d.reach.value = "picked";
    d.projectIds.value = ["p2"];
    expect(d.accessDirty(flux)).toBe(true);
    expect(d.accessBody(flux)).toEqual({
      projects: ["p2"],
      personal: "off",
      read: true,
      write: true,
    });
    d.resetAccess(flux);
    expect(d.accessDirty(flux)).toBe(false);
  });

  test.serial(
    "an edited Access part never sends back another admin's change",
    () => {
      const d = McpDrafts.of(flux);
      d.personal.value = "off";
      const after = { ...flux, write: !flux.write };
      d.follow(flux, after);
      expect(d.write.value).toBe(after.write);
      expect(d.accessBody(after)).toEqual({ personal: "off" });
    },
  );

  test.serial("General draws one Access card with one foot", () => {
    servers.value = [flux];
    path.value = "/admin/config/mcp/flux";
    const html = render(<McpPage params={{ name: "flux" }} />);
    expect(html).toContain(">Access<");
    expect(html).toContain(">Team projects<");
    expect(html).toContain(">Personal projects<");
    expect(html).toContain(">Most a project may use<");
    expect(html).not.toContain("Tool access");
    // Endpoint, Access, Call timeout and Instructions each save
    expect(html.match(/>Discard</g)).toHaveLength(4);
  });

  test.serial("a card at rest follows the row, an edited one stays", () => {
    const d = McpDrafts.of(flux);
    d.write.value = true;
    d.follow(flux, server({ timeoutMs: 30_000 }));
    expect(d.timeout.value).toBe("30");
    expect(d.write.value).toBe(true);
    d.follow(
      server({ timeoutMs: 30_000 }),
      server({ timeoutMs: 30_000, write: false }),
    );
    expect(d.write.value).toBe(true);
  });
});

describe("a server's projects", () => {
  const finops = { id: "p2", name: "finops" };
  const research = { id: "p3", name: "research" };

  test("the list row says all teams, the count, or none, then personal", () => {
    expect(grantWords(flux)).toBe("All teams · personal read");
    expect(
      grantWords(server({ scope: "projects", projects: [], personal: "off" })),
    ).toBe("No projects");
    expect(
      grantWords(
        server({
          scope: "projects",
          projects: [finops, research],
          personal: "write",
        }),
      ),
    ).toBe("2 projects · personal read and write");
  });

  test("where it is on: team projects by name, personal ones as a count", () => {
    expect(onWords([], 0)).toBe("No projects");
    expect(onWords(["finops", "research"], 1)).toBe(
      "finops, research, 1 personal project",
    );
    const on = { projects: [finops], personal: 2 };
    expect(deleteLine(on)).toBe("On in finops, 2 personal projects.");
    expect(deleteAsk("flux", on)).toBe(
      "Delete flux? It is on in finops, 2 personal projects.",
    );
    expect(deleteLine({ projects: [], personal: 0 })).toBe("On in no project.");
    expect(deleteAsk("flux", { projects: [], personal: 0 })).toBe(
      "Delete flux?",
    );
  });

  test("a keyless server's personal grant starts at read, a keyed one unset", () => {
    expect(personalForKey(false)).toBe("read");
    expect(personalForKey(true)).toBe("");
    expect(personalProblem("")).not.toBeNull();
    expect(personalProblem("off")).toBeNull();
    // only a keyed grant that is on warns
    expect(personalHint("read", true)).toContain("key's owner");
    expect(personalHint("off", true)).toBeUndefined();
    expect(personalHint("read", false)).toBeUndefined();
  });

  test("a keyless server starts at all, a keyed one at nothing", () => {
    expect(reachForKey(false)).toBe("all");
    expect(reachForKey(true)).toBe("");
    expect(reachOf(flux)).toBe("all");
    expect(reachOf(server({ scope: "projects" }))).toBe("picked");
  });

  test("a keyed server with nothing picked cannot save", () => {
    expect(projectsProblem(true, "", [])).not.toBeNull();
    expect(projectsProblem(true, "picked", [])).not.toBeNull();
    expect(projectsProblem(true, "picked", ["p2"])).toBeNull();
    expect(projectsProblem(true, "all", [])).toBeNull();
    // a keyless one may be offered nowhere
    expect(projectsProblem(false, "picked", [])).toBeNull();
    expect(projectsBody("all", ["p2"])).toBe("all");
    expect(projectsBody("picked", ["p2"])).toEqual(["p2"]);
    expect(projectsBody("", [])).toBeUndefined();
  });

  test("the hint names a consequence only", () => {
    expect(reachHint("all", [], true)).toBeUndefined();
    expect(reachHint("picked", [], false)).toBe("Offered in no team project.");
    // a keyed server's empty pick is the field's error, not a hint
    expect(reachHint("picked", [], true)).toBeUndefined();
    expect(reachHint("picked", ["p2"], false)).toBeUndefined();
    expect(reachHint("", [], true)).toBeUndefined();
  });

  test("the server's refusals land on the field", () => {
    expect(mcpFieldOf("projects must be all or distinct project ids")).toBe(
      "projects",
    );
    expect(mcpFieldOf("a server with a key needs projects")).toBe("projects");
    expect(mcpFieldOf("no such team project p9")).toBe("projects");
  });

  test.serial("the list row and the page show the scope", () => {
    const bound = server({ scope: "projects", projects: [finops] });
    servers.value = [bound];
    expect(render(<McpList />)).toContain("1 project · personal read");
    path.value = "/admin/config/mcp/flux";
    const html = render(<McpPage params={{ name: "flux" }} />);
    expect(html).toContain(">Team projects<");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Picked projects</);
    expect(html).toContain(">finops<");
  });

  test.serial("the drafts follow the projects at rest", () => {
    const d = McpDrafts.of(flux);
    expect(d.projectsDirty(flux)).toBe(false);
    d.reach.value = "picked";
    expect(d.projectsDirty(flux)).toBe(true);
    const bound = server({ scope: "projects", projects: [finops] });
    d.resetProjects(bound);
    expect(d.projectIds.value).toEqual(["p2"]);
    d.projectIds.value = ["p2", "p3"];
    expect(d.projectsDirty(bound)).toBe(true);
    // an edited card stays, one at rest takes the newer row
    d.follow(bound, server({ scope: "projects", projects: [research] }));
    expect(d.projectIds.value).toEqual(["p2", "p3"]);
    d.resetProjects(bound);
    d.follow(bound, server({ scope: "projects", projects: [research] }));
    expect(d.projectIds.value).toEqual(["p3"]);
  });
});

describe("a tool's parameters", () => {
  test.serial("the server's HTML, cut until Show all", () => {
    const html = render(
      <ToolParams
        tool={{
          parameters: { type: "object" },
          parametersHtml: "<pre>{}</pre>",
        }}
      />,
    );
    expect(html).toContain("<pre>{}</pre>");
    expect(html).toContain("tool-params-cut");
  });
});
