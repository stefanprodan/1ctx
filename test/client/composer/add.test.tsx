// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  agentMoved,
  memoryItem,
  onWords,
  panelessOf,
  serversItem,
  skillsItem,
  visualsItem,
  webItem,
  webPaneItem,
} from "../../../src/client/composer/Add.model.ts";
import { AddPane } from "../../../src/client/composer/AddPane.tsx";
import { MEMORY, VISUALIZE, WEB } from "../../../src/shared/capabilities.ts";

describe("the Web access item", () => {
  test("is live and on when the instance allows it and the chat left it", () => {
    expect(webItem({ tools: true, switchable: [WEB], off: false })).toEqual({
      live: true,
      on: true,
      reason: null,
    });
  });

  test("is live and off once the chat turned it off", () => {
    expect(webItem({ tools: true, switchable: [WEB], off: true })).toEqual({
      live: true,
      on: false,
      reason: null,
    });
  });

  test("cannot be switched while an admin has it off, and says so", () => {
    expect(webItem({ tools: true, switchable: [], off: false })).toEqual({
      live: false,
      on: false,
      reason: "Turned off by an admin",
    });
  });

  test("an agent without tools comes before the admin's word", () => {
    expect(webItem({ tools: false, switchable: [WEB], off: false })).toEqual({
      live: false,
      on: false,
      reason: "Agent cannot use tools",
    });
    expect(webItem({ tools: false, switchable: [], off: false }).reason).toBe(
      "Agent cannot use tools",
    );
  });

  test("waits without a reason until the project's agents answered", () => {
    expect(webItem({ tools: true, switchable: null, off: false })).toEqual({
      live: false,
      on: false,
      reason: null,
    });
  });
});

describe("the Visuals item", () => {
  test("follows its own key, apart from web access", () => {
    expect(
      visualsItem({ tools: true, switchable: [WEB, VISUALIZE], off: false }),
    ).toEqual({ live: true, on: true, reason: null });
    expect(
      visualsItem({ tools: true, switchable: [WEB, VISUALIZE], off: true }),
    ).toEqual({ live: true, on: false, reason: null });
    expect(visualsItem({ tools: true, switchable: [WEB], off: false })).toEqual(
      { live: false, on: false, reason: "Turned off by an admin" },
    );
    expect(
      webItem({ tools: true, switchable: [VISUALIZE], off: false }),
    ).toEqual({ live: false, on: false, reason: "Turned off by an admin" });
    expect(
      visualsItem({ tools: false, switchable: [VISUALIZE], off: false }).reason,
    ).toBe("Agent cannot use tools");
    expect(visualsItem({ tools: true, switchable: null, off: false })).toEqual({
      live: false,
      on: false,
      reason: null,
    });
  });
});

describe("the Memory item", () => {
  test("is on unless the chat turned it off, off for an agent without tools", () => {
    expect(
      memoryItem({ tools: true, switchable: [MEMORY], off: false }),
    ).toEqual({ live: true, on: true, reason: null });
    expect(
      memoryItem({ tools: true, switchable: [MEMORY], off: true }),
    ).toEqual({ live: true, on: false, reason: null });
    expect(
      memoryItem({ tools: false, switchable: [MEMORY], off: false }),
    ).toEqual({ live: false, on: false, reason: "Agent cannot use tools" });
    // web access off on the instance leaves memory alone
    expect(
      memoryItem({ tools: true, switchable: [MEMORY], off: false }).live,
    ).toBe(true);
    expect(
      webItem({ tools: true, switchable: [MEMORY], off: false }).reason,
    ).toBe("Turned off by an admin");
  });
});

describe("the MCP servers item", () => {
  const servers = [
    { id: "a1", name: "flux", tools: 18 },
    { id: "b2", name: "github", tools: 42 },
  ];

  test("is absent for an agent without servers", () => {
    expect(
      serversItem({ tools: true, servers: [], isOff: () => false }),
    ).toBeNull();
  });

  test("lists a switch per server and counts the ones on", () => {
    const item = serversItem({
      tools: true,
      servers,
      isOff: (key) => key === "mcp:a1",
    });
    expect(item).toEqual({
      live: true,
      reason: null,
      on: 1,
      rows: [
        {
          key: "mcp:a1",
          name: "flux",
          note: "18 tools",
          on: false,
          live: true,
          reason: null,
        },
        {
          key: "mcp:b2",
          name: "github",
          note: "42 tools",
          on: true,
          live: true,
          reason: null,
        },
      ],
    });
    expect(onWords(item!)).toBe("1 on");
  });

  test("an agent without tools shows it off and says why", () => {
    expect(serversItem({ tools: false, servers, isOff: () => false })).toEqual({
      live: false,
      reason: "Agent cannot use tools",
      on: 0,
      rows: [],
    });
  });
});

describe("the MCP servers pane", () => {
  test("is a back row, then a switch per server with its tools", () => {
    const html = render(
      <AddPane
        title="MCP servers"
        icon="mcp"
        rows={[
          {
            key: "mcp:a1",
            name: "<flux>",
            note: "18 tools",
            on: false,
            live: true,
            reason: null,
          },
          {
            key: "mcp:b2",
            name: "github",
            note: "42 tools",
            on: true,
            live: true,
            reason: null,
          },
        ]}
        onBack={() => {}}
        onFlip={() => {}}
      />,
    );
    expect(html.indexOf("composer-add-back")).toBeLessThan(
      html.indexOf("&lt;flux>"),
    );
    expect(html).toContain('role="switch" aria-checked="false"');
    expect(html).toContain('role="switch" aria-checked="true"');
    expect(html).toContain("18 tools");
    expect(html.match(/switch-on/g)?.length).toBe(1);
  });
});

describe("the Skills item", () => {
  const skills = [
    { id: "s1", name: "gitops" },
    { id: "s2", name: "visualize" },
  ];

  test("is absent for an agent without skills", () => {
    expect(
      skillsItem({ tools: true, skills: [], isOff: () => false }),
    ).toBeNull();
  });

  test("lists a switch per skill, with nothing to count, and the ones on", () => {
    expect(
      skillsItem({ tools: true, skills, isOff: (key) => key === "skill:s2" }),
    ).toEqual({
      live: true,
      reason: null,
      on: 1,
      rows: [
        {
          key: "skill:s1",
          name: "gitops",
          note: "",
          on: true,
          live: true,
          reason: null,
        },
        {
          key: "skill:s2",
          name: "visualize",
          note: "",
          on: false,
          live: true,
          reason: null,
        },
      ],
    });
    const none = skillsItem({ tools: true, skills, isOff: () => true });
    expect(onWords(none!)).toBe("0 on");
  });

  test("an agent without tools shows it off and says why", () => {
    expect(skillsItem({ tools: false, skills, isOff: () => false })).toEqual({
      live: false,
      reason: "Agent cannot use tools",
      on: 0,
      rows: [],
    });
  });
});

// bug: back at the menu counted as a pane gone, so the reset queued there
// undid a pane picked before it ran
describe("the plus falling back to its menu", () => {
  const live = { live: true, reason: null, on: 0, rows: [] };

  test("never from the menu itself while open", () => {
    expect(panelessOf(true, "menu", null)).toBe(false);
  });

  test("when closed, or when what the pane lists is gone or off", () => {
    expect(panelessOf(false, "menu", null)).toBe(true);
    expect(panelessOf(false, "skills", live)).toBe(true);
    expect(panelessOf(true, "skills", live)).toBe(false);
    expect(panelessOf(true, "skills", null)).toBe(true);
    expect(panelessOf(true, "servers", { ...live, live: false })).toBe(true);
  });
});

// bug: the agent list going away for a moment dropped the server flips
describe("another agent picked", () => {
  test("is a move from one agent to another, never through none", () => {
    expect(agentMoved(null, "alpha")).toBe(false);
    expect(agentMoved("alpha", null)).toBe(false);
    expect(agentMoved("alpha", "alpha")).toBe(false);
    expect(agentMoved("alpha", "beta")).toBe(true);
  });
});

describe("the Web access item with credentials", () => {
  const credentials = [
    { id: "c1", name: "finnhub" },
    { id: "c2", name: "github" },
  ];
  const on = { live: true, on: true, reason: null };

  test("stays the plain switch while the project has none", () => {
    expect(
      webPaneItem({ web: on, credentials: [], isOff: () => false }),
    ).toBeNull();
  });

  test("is Web access, then a switch per credential, counting those on", () => {
    const item = webPaneItem({
      web: on,
      credentials,
      isOff: (key) => key === "credential:c2",
    })!;
    expect(item.live).toBe(true);
    expect(item.on).toBe(1);
    expect(onWords(item)).toBe("1 on");
    expect(item.rows.map((row) => [row.key, row.on, row.live])).toEqual([
      [WEB, true, true],
      ["credential:c1", true, true],
      ["credential:c2", false, true],
    ]);
    expect(item.rows[0]!.plain).toBe(true);
  });

  test("with the web off, every credential is faint and off, saying why", () => {
    const item = webPaneItem({
      web: { live: true, on: false, reason: null },
      credentials,
      isOff: () => false,
    })!;
    expect(onWords(item)).toBe("0 on");
    expect(item.rows[0]).toMatchObject({ key: WEB, on: false, live: true });
    for (const row of item.rows.slice(1)) {
      expect(row).toMatchObject({
        on: false,
        live: false,
        reason: "Web access is off",
      });
    }
  });

  test("when the web cannot be switched, the credentials take its reason", () => {
    const web = webItem({ tools: true, switchable: [], off: false });
    const item = webPaneItem({ web, credentials, isOff: () => false })!;
    expect(item.live).toBe(true);
    expect(item.reason).toBe("Turned off by an admin");
    expect(item.rows.map((row) => row.reason)).toEqual([
      "Turned off by an admin",
      "Turned off by an admin",
      "Turned off by an admin",
    ]);
    expect(item.rows.every((row) => !row.live && !row.on)).toBe(true);
    const tools = webItem({ tools: false, switchable: [WEB], off: false });
    expect(
      webPaneItem({ web: tools, credentials, isOff: () => false })!.rows[1]!
        .reason,
    ).toBe("Agent cannot use tools");
  });

  test("waits for the project's agents to answer", () => {
    const web = webItem({ tools: true, switchable: null, off: false });
    const item = webPaneItem({ web, credentials, isOff: () => false })!;
    expect(item.live).toBe(false);
  });

  test("the pane draws a credential off with its reason under the name", () => {
    const item = webPaneItem({
      web: { live: true, on: false, reason: null },
      credentials,
      isOff: () => false,
    })!;
    const html = render(
      <AddPane
        title="Web access"
        icon="globe"
        rows={item.rows}
        onBack={() => {}}
        onFlip={() => {}}
      />,
    );
    expect(html).toContain("finnhub");
    expect(html).toContain("Web access is off");
    expect(html.match(/disabled/g)?.length).toBe(2);
  });
});
