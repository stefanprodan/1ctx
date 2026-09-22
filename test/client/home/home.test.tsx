// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { query } from "../../../src/client/app/router.ts";
import { me } from "../../../src/client/data/me.ts";
import { projects } from "../../../src/client/data/projects.ts";
import {
  homeProjectId,
  list,
  projectAgents,
} from "../../../src/client/data/sessions.ts";
import { week } from "../../../src/client/data/usage.ts";
import {
  dateLine,
  greeting,
} from "../../../src/client/views/home/Home.model.ts";
import { Home } from "../../../src/client/views/home/Home.tsx";
import { Login } from "../../../src/client/views/home/Login.tsx";

describe("Home.model", () => {
  test("greets by the hour", () => {
    const at = (h: number) => new Date(2026, 8, 12, h);
    expect(greeting(at(3), "Casey")).toBe("Good night, Casey");
    expect(greeting(at(9), "Casey")).toBe("Good morning, Casey");
    expect(greeting(at(14), "Casey")).toBe("Good afternoon, Casey");
    expect(greeting(at(21), "Casey")).toBe("Good evening, Casey");
  });

  test("the date line is weekday, day and month", () => {
    expect(dateLine(new Date(2026, 8, 12))).toBe("Saturday 12 September");
  });
});

describe("Home", () => {
  beforeEach(() => {
    me.value = {
      id: "u1",
      username: "casey",
      fullName: "Casey",
      role: "member",
      mustChangePassword: false,
    };
    query.value = "";
    projects.value = [
      {
        id: "p1",
        kind: "personal",
        name: "personal",
        createdAt: 0,
        memberCount: 1,
      },
    ];
    projectAgents.value = [
      {
        id: "a1",
        name: "assistant",
        avatar: "bot",
        providerId: "pr1",
        model: {
          id: "acme/small",
          name: "Small",
          contextLength: null,
          promptPrice: null,
          completionPrice: null,
          tools: false,
          reasoning: false,
          described: true,
        },
        thinking: null,
        effort: null,
        prompt: "",
        skills: [],
        servers: [],
        mcpMode: "auto",
        createdAt: 1_756_684_800_000,
      },
    ];
    homeProjectId.value = null;
    list.value = null;
    week.value = null;
  });

  test("renders the head, the composer and the search", () => {
    const html = render(<Home />);
    expect(html).toContain('class="page-title"');
    expect(html).toContain(", Casey</h1>");
    expect(html).toContain('class="composer composer-tall card"');
    expect(html).toContain('rows="2"');
    expect(html).toContain('placeholder="Search sessions"');
    expect(html).toContain("Loading");
    // the aside: the agents, and the week once it answers
    expect(html).toContain(
      'class="split-name split-name-link" href="/agents/assistant">assistant<',
    );
    expect(html).toContain('class="split-faint">acme/small<');
    expect(html).not.toContain("Manage");
    week.value = {
      since: 0,
      until: 1,
      sends: 1_284,
      sessions: 637,
      promptTokens: 2_130_000,
      completionTokens: 12_400,
    };
    const again = render(<Home />);
    expect(again).toContain('class="split-value">1.28k<');
    expect(again).toContain('class="split-value">637<');
    // prompt and completion tokens as one number
    expect(again).toContain('class="split-value">2.14M<');
    // the recent weeks are the project page's, not Home's
    expect(again).not.toContain("activity-grid");
  });

  test("renders the rows with the project name and the state line", () => {
    list.value = [
      {
        session: {
          id: "s1",
          projectId: "p1",
          ownerId: "u1",
          agentId: "a1",
          origin: "chat",
          automationId: null,
          runSource: null,
          forkedFromId: null,
          title: "Which pods restarted",
          status: "done",
          revision: 2,
          createdAt: 0,
          lastActivityAt: Date.now() - 120_000,
          usage: null,
          disabledCapabilities: [],
        },
        agent: "assistant",
        send: null,
        last: { seq: 2, author: "assistant", text: "nine pods" },
        automation: null,
        runBy: null,
      },
    ];
    const html = render(<Home />);
    expect(html).toContain('href="/chat/s1"');
    expect(html).toContain("status-done");
    expect(html).toContain("Which pods restarted");
    expect(html).toContain('<span class="stream-project">#personal</span>');
    expect(html).toContain(
      '<span class="stream-author">@assistant </span>nine pods',
    );
    expect(html).toContain("2m ago");
  });

  test("the search box carries the address's query and the empty line says so", () => {
    query.value = "?q=pods";
    list.value = [];
    const html = render(<Home />);
    expect(html).toContain('value="pods"');
    expect(html).toContain("No sessions match");
    query.value = "";
    expect(render(<Home />)).toContain("No sessions found");
  });

  test.serial(
    "the composer names its project, the personal one at first",
    () => {
      projects.value = [
        ...projects.value!,
        {
          id: "p2",
          kind: "team",
          name: "platform",
          createdAt: 0,
          memberCount: 3,
        },
      ];
      const html = render(<Home />);
      expect(html).toContain('placeholder="Send a message to personal"');
      expect(html).toContain('class="composer-chip-name">personal<');
      homeProjectId.value = "p2";
      const picked = render(<Home />);
      expect(picked).toContain('placeholder="Send a message to platform"');
      expect(picked).toContain('class="composer-chip-name">platform<');
    },
  );

  test("without the personal project the composer waits", () => {
    projects.value = null;
    const html = render(<Home />);
    expect(html).not.toContain('class="composer');
    expect(html).toContain('placeholder="Search sessions"');
  });
});

describe("Login", () => {
  test("renders the form with the classes login.css depends on", () => {
    const html = render(<Login />);
    expect(html).toContain('class="login"');
    expect(html).toContain('class="login-form card"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Sign in");
  });
});
