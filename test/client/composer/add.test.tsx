// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  agentMoved,
  serversItem,
  webItem,
} from "../../../src/client/composer/Add.model.ts";
import { AddServers } from "../../../src/client/composer/AddServers.tsx";
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
        { id: "a1", name: "flux", tools: 18, key: "mcp:a1", on: false },
        { id: "b2", name: "github", tools: 42, key: "mcp:b2", on: true },
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
      <AddServers
        rows={[
          { id: "a1", name: "<flux>", tools: 18, key: "mcp:a1", on: false },
          { id: "b2", name: "github", tools: 42, key: "mcp:b2", on: true },
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

// bug: the agent list going away for a moment dropped the server flips
describe("another agent picked", () => {
  test("is a move from one agent to another, never through none", () => {
    expect(agentMoved(null, "alpha")).toBe(false);
    expect(agentMoved("alpha", null)).toBe(false);
    expect(agentMoved("alpha", "alpha")).toBe(false);
    expect(agentMoved("alpha", "beta")).toBe(true);
  });
});
