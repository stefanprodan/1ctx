// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Connect agents: each agent's MCP server and skill lines, the tab an
// address picks, and when the page draws Setup and the New access key
// page.

import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path, query } from "../../../src/client/app/router.ts";
import {
  accessKeys,
  accessKeysLimit,
} from "../../../src/client/data/access-keys.ts";
import { me } from "../../../src/client/data/me.ts";
import { Connect } from "../../../src/client/views/connect/Connect.tsx";
import {
  type Agent,
  setupAgent,
  setupLines,
  skillUrl,
} from "../../../src/client/views/connect/Setup.model.ts";

const ORIGIN = "https://1ctx.example.test";
const AGENTS: Agent[] = ["claude", "codex", "opencode"];

const lines = (agent: Agent) => {
  const [mcp, skill] = setupLines(ORIGIN, agent);
  return { mcp: mcp!, skill: skill! };
};

describe("the setup lines", () => {
  test("every agent reads the key from the variable, never holds one", () => {
    for (const agent of AGENTS) {
      const { mcp, skill } = lines(agent);
      expect(mcp.label).toBe("MCP server");
      expect(mcp.text).toContain(`${ORIGIN}/mcp`);
      expect(mcp.text).toContain("ONECTX_ACCESS_KEY");
      expect(mcp.text).not.toContain("1ctx_");
      expect(skill.label).toBe("Skill");
      expect(skill.text).toContain(skillUrl(ORIGIN));
    }
  });

  test("Claude Code single-quotes the header so the shell keeps the variable", () => {
    expect(lines("claude").mcp.text).toBe(
      [
        "claude mcp add --transport http --scope user 1ctx \\",
        `  "${ORIGIN}/mcp" \\`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's variable, kept literal
        "  --header 'Authorization: Bearer ${ONECTX_ACCESS_KEY}'",
      ].join("\n"),
    );
  });

  test("Codex names the variable in its config table", () => {
    expect(lines("codex").mcp.text).toBe(
      [
        "[mcp_servers.1ctx]",
        `url = "${ORIGIN}/mcp"`,
        'bearer_token_env_var = "ONECTX_ACCESS_KEY"',
      ].join("\n"),
    );
  });

  test("OpenCode's entry is JSON with the env reference and no OAuth", () => {
    const parsed = JSON.parse(`{${lines("opencode").mcp.text}}`);
    expect(parsed).toEqual({
      mcp: {
        "1ctx": {
          type: "remote",
          url: `${ORIGIN}/mcp`,
          headers: { Authorization: "Bearer {env:ONECTX_ACCESS_KEY}" },
          oauth: false,
        },
      },
    });
  });

  test("each agent installs the skill into its own folder", () => {
    const dirs: Record<Agent, string> = {
      claude: "~/.claude/skills/external-tasks/SKILL.md",
      codex: "~/.agents/skills/external-tasks/SKILL.md",
      opencode: "~/.config/opencode/skills/external-tasks/SKILL.md",
    };
    for (const agent of AGENTS) {
      expect(lines(agent).skill.text).toBe(
        [
          "curl -fsSL --create-dirs \\",
          `  -o ${dirs[agent]} \\`,
          `  "${ORIGIN}/.well-known/skills/external-tasks/SKILL.md"`,
        ].join("\n"),
      );
    }
  });

  test("every URL is quoted, so a shell never globs an IPv6 origin's brackets", () => {
    for (const agent of ["claude", "codex", "opencode"] as const) {
      for (const line of setupLines("http://[::1]:1236", agent)) {
        expect(line.text).toContain('"http://[::1]:1236/');
      }
    }
  });

  test("the address picks the tab, Claude Code by default", () => {
    expect(setupAgent("/connect")).toBe("claude");
    expect(setupAgent("/connect/codex")).toBe("codex");
    expect(setupAgent("/connect/opencode")).toBe("opencode");
    expect(setupAgent("/connect/other")).toBe("claude");
  });
});

describe("the page", () => {
  beforeEach(() => {
    me.value = {
      id: "u1",
      username: "casey",
      fullName: "Casey Doe",
      role: "member",
      mustChangePassword: false,
    };
    accessKeys.value = [];
    accessKeysLimit.value = 5;
    path.value = "/connect";
    query.value = "";
  });

  test.serial("draws the keys, the line and the Setup tabs", () => {
    path.value = "/connect/codex";
    const html = render(<Connect />);
    expect(html).toContain(">Access keys<");
    expect(html).toContain("pick up external tasks to work on");
    expect(html).toMatch(/aria-current="page"[^>]*>Codex</);
    expect(html).toContain("[mcp_servers.1ctx]");
    expect(html).toContain("~/.agents/skills/external-tasks/SKILL.md");
  });

  test.serial("leaves Setup out with keys off and none kept", () => {
    accessKeysLimit.value = 0;
    expect(render(<Connect />)).not.toContain("MCP server");
    accessKeys.value = [
      {
        id: "k1",
        name: "kept",
        scope: "read",
        projectIds: null,
        createdAt: 0,
        expiresAt: Date.now() + 86_400_000,
        lastUsedAt: null,
      },
    ];
    expect(render(<Connect />)).toContain("MCP server");
  });

  test.serial("?new is the New access key page", () => {
    query.value = "?new";
    const html = render(<Connect />);
    expect(html).toContain("New access key");
    expect(html).toContain("Create access key");
    expect(html).not.toContain("MCP server");
  });
});
