// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  agentMoved,
  panelessOf,
  serversItem,
  skillsItem,
  webItem,
} from "../../../src/client/composer/Add.model.ts";
import { AddPane } from "../../../src/client/composer/AddPane.tsx";
import { WEB } from "../../../src/shared/capabilities.ts";

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

  test("lists a switch per server and counts the ones off", () => {
    const item = serversItem({
      tools: true,
      servers,
      isOff: (key) => key === "mcp:a1",
    });
    expect(item).toEqual({
      live: true,
      reason: null,
      off: 1,
      rows: [
        { key: "mcp:a1", name: "flux", note: "18 tools", on: false },
        { key: "mcp:b2", name: "github", note: "42 tools", on: true },
      ],
    });
  });

  test("an agent without tools shows it off and says why", () => {
    expect(serversItem({ tools: false, servers, isOff: () => false })).toEqual({
      live: false,
      reason: "Agent cannot use tools",
      off: 0,
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
          { key: "mcp:a1", name: "<flux>", note: "18 tools", on: false },
          { key: "mcp:b2", name: "github", note: "42 tools", on: true },
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

  test("lists a switch per skill, with nothing to count, and the ones off", () => {
    expect(
      skillsItem({ tools: true, skills, isOff: (key) => key === "skill:s2" }),
    ).toEqual({
      live: true,
      reason: null,
      off: 1,
      rows: [
        { key: "skill:s1", name: "gitops", note: "", on: true },
        { key: "skill:s2", name: "visualize", note: "", on: false },
      ],
    });
  });

  test("an agent without tools shows it off and says why", () => {
    expect(skillsItem({ tools: false, skills, isOff: () => false })).toEqual({
      live: false,
      reason: "Agent cannot use tools",
      off: 0,
      rows: [],
    });
  });
});

// bug: back at the menu counted as a pane gone, so the reset queued there
// undid a pane picked before it ran
describe("the plus falling back to its menu", () => {
  const live = { live: true, reason: null, off: 0, rows: [] };

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
