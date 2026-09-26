// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page and an agent's page render what the directory answered,
// and their words come from People.model.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import {
  agentDays,
  agentDaysFailed,
  agentPage,
  agentPageError,
  loadAgentDays,
  loadAgentPage,
  loadPerson,
  person,
  personError,
} from "../../../src/client/data/directory.ts";
import { me } from "../../../src/client/data/me.ts";
import { tokensText } from "../../../src/client/lib/format.ts";
import { agentHref, userHref } from "../../../src/client/lib/hrefs.ts";
import { Agent } from "../../../src/client/views/people/Agent.tsx";
import {
  agentAnswer,
  agentTab,
  agentTabs,
  effortText,
  localTime,
  roleWords,
  serverLine,
  serverMeta,
  thinkingText,
} from "../../../src/client/views/people/People.model.ts";
import { User } from "../../../src/client/views/people/User.tsx";
import type {
  DirectoryAgentDaysResponse,
  DirectoryAgentResponse,
  DirectoryUserResponse,
} from "../../../src/shared/api/directory.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const casey: Me = {
  id: "u1",
  username: "casey",
  fullName: "Casey Doe",
  role: "member",
  mustChangePassword: false,
};

const agent: DirectoryAgentResponse = {
  agent: {
    id: "a1",
    name: "coder",
    avatar: "bot",
    providerId: "pr1",
    model: {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek: V4 Flash",
      contextLength: 128_000,
      promptPrice: 0.14,
      completionPrice: 0.28,
      tools: true,
      reasoning: true,
      thinkingRequired: false,
      reasoningKnown: true,
      described: true,
    },
    thinking: "on",
    effort: "high",
    prompt: "You write code.\nSmall diffs.",
    skills: ["s1"],
    servers: [],
    mcpMode: "auto",
    upstream: null,
    createdAt: 0,
  },
  provider: "router",
  skills: [
    {
      id: "s1",
      name: "timoni",
      description: "Deploy with Timoni.",
      hasFiles: false,
      fetchedAt: Date.now() - 2 * 60 * 60 * 1000,
    },
  ],
  tools: [
    { name: "datetime", provider: null },
    { name: "websearch", provider: "exa" },
  ],
  mcp: { servers: [], tokens: 0 },
  tokens: { prompt: 7, skills: 2000, tools: 300 },
};

// two days, the agent busy on the second
const days: DirectoryAgentDaysResponse = {
  since: Date.UTC(2026, 8, 14),
  until: Date.UTC(2026, 8, 16),
  days: ["2026-09-14", "2026-09-15"],
  total: { sends: 3, tokens: 4000 },
  usage: [
    { sends: 0, tokens: 0 },
    { sends: 3, tokens: 4000 },
  ],
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  me.value = casey;
  person.value = null;
  personError.value = null;
  agentPage.value = null;
  agentPageError.value = null;
  agentDays.value = null;
  agentDaysFailed.value = false;
  path.value = "/agents/coder";
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const personOf = (username: string): DirectoryUserResponse => ({
  user: {
    id: `id-${username}`,
    username,
    fullName: username,
    role: "member",
    email: `${username}@example.com`,
    tz: "UTC",
    about: "",
    createdAt: 0,
    disabled: false,
  },
  projects: [],
});

// every request waits until the test opens its gate, answering with the
// body for the name at the end of the address
function gated(answer: (name: string) => Response) {
  const gates: (() => void)[] = [];
  globalThis.fetch = ((url: string) =>
    new Promise<Response>((resolve) => {
      const name = decodeURIComponent(url.split("/").pop() ?? "");
      gates.push(() => resolve(answer(name)));
    })) as unknown as typeof fetch;
  return gates;
}

describe("the directory entity", () => {
  test.serial("an older user answer never overwrites a newer one", async () => {
    const gates = gated((name) => Response.json(personOf(name)));
    const first = loadPerson("bogdan");
    const second = loadPerson("elena");
    gates[1]();
    await second;
    gates[0]();
    await first;
    expect(person.value?.user.username).toBe("elena");
  });

  test.serial("another name drops the page shown at once", async () => {
    person.value = personOf("bogdan");
    const gates = gated((name) => Response.json(personOf(name)));
    const pending = loadPerson("dana");
    expect(person.value).toBeNull();
    gates[0]();
    await pending;
    expect(person.value?.user.username).toBe("dana");
  });

  test.serial(
    "a page seen before is drawn at once and loaded again",
    async () => {
      const gates = gated((name) => Response.json(personOf(name)));
      const first = loadPerson("radu");
      gates[0]();
      await first;
      const second = loadPerson("irina");
      gates[1]();
      await second;
      const back = loadPerson("radu");
      expect(person.value?.user.username).toBe("radu");
      gates[2]();
      await back;
      expect(person.value?.user.username).toBe("radu");
    },
  );

  test.serial("a failed page is not drawn from what was held", async () => {
    let status = 200;
    globalThis.fetch = (async (url: string) =>
      status === 200
        ? Response.json(
            personOf(decodeURIComponent(url.split("/").pop() ?? "")),
          )
        : Response.json(
            { error: "no such user" },
            { status },
          )) as unknown as typeof fetch;
    await loadPerson("ion");
    await loadPerson("maria");
    status = 404;
    await loadPerson("ion");
    expect(person.value).toBeNull();
    status = 200;
    await loadPerson("maria");
    const pending = loadPerson("ion");
    expect(person.value).toBeNull();
    await pending;
  });

  test.serial(
    "an answer that lands after the user changed is dropped",
    async () => {
      const gates = gated((name) => Response.json(personOf(name)));
      const pending = loadPerson("bogdan");
      me.value = { ...casey, id: "u9", username: "someone" };
      gates[0]();
      await pending;
      expect(person.value).toBeNull();
      me.value = null;
      expect(personError.value).toBeNull();
    },
  );

  test.serial("a failure is the page's words and status", async () => {
    const gates = gated(() =>
      Response.json({ error: "no such user" }, { status: 404 }),
    );
    const pending = loadPerson("nobody");
    gates[0]();
    await pending;
    expect(personError.value).toEqual({ words: "no such user", status: 404 });
    expect(person.value).toBeNull();
  });

  test.serial(
    "an older agent answer never overwrites a newer one",
    async () => {
      const gates = gated((name) =>
        Response.json({ ...agent, agent: { ...agent.agent, name } }),
      );
      const first = loadAgentPage("coder");
      const second = loadAgentPage("tester");
      gates[1]();
      await second;
      gates[0]();
      await first;
      expect(agentPage.value?.agent.name).toBe("tester");
      expect(agentPageError.value).toBeNull();
    },
  );
});

describe("the agent's days", () => {
  test.serial("asks in the browser's zone and keeps the latest", async () => {
    const asked: string[] = [];
    const gates: (() => void)[] = [];
    globalThis.fetch = ((url: string) =>
      new Promise<Response>((resolve) => {
        asked.push(url);
        gates.push(() => resolve(Response.json(days)));
      })) as unknown as typeof fetch;
    const first = loadAgentDays("coder");
    const second = loadAgentDays("writer");
    expect(asked[0]).toStartWith("/api/directory/agents/coder/days?tz=");
    gates[1]();
    await second;
    gates[0]();
    await first;
    expect(agentDays.value?.name).toBe("writer");
  });

  test.serial(
    "a failed first load is failed, a failed refresh keeps the days",
    async () => {
      let ok = true;
      globalThis.fetch = (async () =>
        ok
          ? Response.json(days)
          : Response.json(
              { error: "down" },
              { status: 500 },
            )) as unknown as typeof fetch;
      ok = false;
      await loadAgentDays("coder");
      expect(agentDays.value).toBeNull();
      expect(agentDaysFailed.value).toBe(true);
      ok = true;
      await loadAgentDays("coder");
      expect(agentDaysFailed.value).toBe(false);
      expect(agentDays.value?.body).toEqual(days);
      ok = false;
      await loadAgentDays("coder");
      expect(agentDaysFailed.value).toBe(false);
      expect(agentDays.value?.body).toEqual(days);
    },
  );

  test.serial("a failed load forgets the held days of that name", async () => {
    globalThis.fetch = (async () =>
      Response.json(days)) as unknown as typeof fetch;
    await loadAgentDays("coder");
    await loadAgentDays("writer");
    globalThis.fetch = (async () =>
      Response.json(
        { error: "no such agent" },
        { status: 404 },
      )) as unknown as typeof fetch;
    await loadAgentDays("coder");
    // back on writer, then coder again: nothing held draws first
    const gates: (() => void)[] = [];
    globalThis.fetch = ((_url: string) =>
      new Promise<Response>((resolve) => {
        gates.push(() => resolve(Response.json(days)));
      })) as unknown as typeof fetch;
    const writer = loadAgentDays("writer");
    gates[0]();
    await writer;
    const coder = loadAgentDays("coder");
    expect(agentDays.value).toBeNull();
    gates[1]();
    await coder;
  });

  test.serial("a new user drops the days and their failure", async () => {
    globalThis.fetch = (async () =>
      Response.json(days)) as unknown as typeof fetch;
    await loadAgentDays("coder");
    agentDaysFailed.value = true;
    me.value = { ...casey, id: "u9", username: "someone" };
    expect(agentDays.value).toBeNull();
    expect(agentDaysFailed.value).toBe(false);
  });
});

describe("People.model", () => {
  test("the addresses of both pages", () => {
    expect(userHref("casey")).toBe("/users/casey");
    expect(agentHref("sre_bot")).toBe("/agents/sre_bot");
  });

  test("the local time with the offset, nothing for an unknown zone", () => {
    const at = Date.UTC(2026, 8, 15, 13, 34);
    expect(localTime("Europe/Bucharest", at)).toBe("16:34 · GMT+3");
    expect(localTime("UTC", at)).toStartWith("13:34");
    expect(localTime("Nowhere/Land", at)).toBe("");
  });

  test("a token count reads in thousands", () => {
    expect(tokensText(1)).toBe("1 token");
    expect(tokensText(2716)).toBe("2.72K tokens");
  });

  test("a role reads as a word", () => {
    expect(roleWords("admin")).toBe("Admin");
    expect(roleWords("member")).toBe("Member");
  });

  test("an MCP server's line: refreshed, or the failure since, in red", () => {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    expect(
      serverLine({ checkedAt: now - 2 * hour, refreshFailedAt: null }, now),
    ).toEqual({ text: "refreshed 2h ago", bad: false });
    expect(
      serverLine(
        { checkedAt: now - 2 * hour, refreshFailedAt: now - 60_000 },
        now,
      ),
    ).toEqual({ text: "refresh failed 1m ago", bad: true });
    expect(serverMeta({ read: true, write: false, tools: 11 })).toBe(
      "11 tools · read access",
    );
    expect(serverMeta({ read: true, write: true, tools: 1 })).toBe(
      "1 tool · read and write access",
    );
    expect(serverMeta({ read: false, write: true, tools: 27 })).toBe(
      "27 tools · write access",
    );
  });

  test("thinking and effort say the default when the agent sets none", () => {
    expect(thinkingText({ thinking: null })).toBe("model default");
    expect(thinkingText({ thinking: "off" })).toBe("off");
    expect(effortText({ thinking: null, effort: null })).toBe(
      "provider default",
    );
    expect(effortText({ thinking: "on", effort: "high" })).toBe("high");
    expect(effortText({ thinking: "off", effort: "high" })).toBe("none");
  });
});

describe("the pages", () => {
  test.serial(
    "User shows the person, the email and the shared projects",
    () => {
      person.value = {
        user: {
          id: "u2",
          username: "bogdan",
          fullName: "Bogdan P",
          role: "member",
          email: "bogdan@example.com",
          tz: "Europe/Bucharest",
          about: "Head of SRE.",
          createdAt: Date.UTC(2026, 8, 12),
          disabled: true,
        },
        projects: [
          { id: "p2", kind: "team", name: "ops", createdAt: 0, memberCount: 3 },
        ],
      };
      path.value = "/users/bogdan";
      let html = render(<User params={{ username: "bogdan" }} />);
      expect(html).toContain(">Bogdan P<");
      expect(html).toContain('class="who-line who-handle">@bogdan<');
      expect(html).toContain(">Disabled<");
      expect(html).toContain('href="mailto:bogdan@example.com"');
      expect(html).toContain("12 September 2026");
      // About first, the projects under their own tab with their count
      expect(html).toContain(
        'class="tabs-tab tabs-tab-on" href="/users/bogdan" aria-current="page">About<',
      );
      expect(html).toContain(
        'href="/users/bogdan/projects">Projects<span class="tabs-count">1<',
      );
      expect(html).toContain(">Head of SRE.<");
      expect(html).not.toContain(">Projects in common<");
      path.value = "/users/bogdan/projects";
      html = render(<User params={{ username: "bogdan" }} />);
      expect(html).toContain(">Projects in common<");
      expect(html).toContain('href="/projects/p2"');
      expect(html).not.toContain(">Head of SRE.<");
      // a stale answer for someone else is not drawn
      expect(render(<User params={{ username: "elena" }} />)).not.toContain(
        "Bogdan P",
      );
    },
  );

  test.serial("User on your own page names your team projects", () => {
    person.value = {
      user: {
        id: "u1",
        username: "casey",
        fullName: "Casey Doe",
        role: "member",
        email: "casey@example.com",
        tz: "UTC",
        about: "",
        createdAt: 0,
        disabled: false,
      },
      projects: [],
    };
    path.value = "/users/casey";
    expect(render(<User params={{ username: "casey" }} />)).toContain(
      "Nothing written yet.",
    );
    path.value = "/users/casey/projects";
    const html = render(<User params={{ username: "casey" }} />);
    expect(html).toContain(">Your team projects<");
    expect(html).toContain("No team projects yet.");
  });

  test.serial(
    "Agent opens on its instructions under the tabs with their counts",
    () => {
      agentPage.value = agent;
      const html = render(<Agent params={{ name: "coder" }} />);
      expect(html).toContain("deepseek/deepseek-v4-flash");
      // the provider under the model, what it offers at the
      // instructions' foot
      expect(html).toContain('class="who-line">router<');
      expect(html).toMatch(
        /class="people-foot"><svg.*<\/svg>128K · \$0\.14 \/ \$0\.28 · tools · reasoning</,
      );
      expect(html).toContain(
        'class="people-prompt clamp">You write code.\nSmall diffs.<',
      );
      expect(html).toContain(
        '>Instructions</span><span class="rows-hint cut">7 tokens<',
      );
      expect(html).toContain(
        'class="tabs-tab tabs-tab-on" href="/agents/coder" aria-current="page">Instructions<',
      );
      expect(html).toContain(
        'href="/agents/coder/tools">Tools<span class="tabs-count">2<',
      );
      expect(html).toContain(
        'href="/agents/coder/skills">Skills<span class="tabs-count">1<',
      );
      expect(html).toContain(
        'href="/agents/coder/mcp">MCP<span class="tabs-count">0<',
      );
      // one tab's card at a time
      expect(html).not.toContain(">timoni<");
      expect(html).not.toContain(">datetime<");
      expect(html).toContain(">high<");
    },
  );

  test.serial("Agent's Tools, Skills and MCP tabs each draw their card", () => {
    agentPage.value = agent;
    path.value = "/agents/coder/tools";
    let html = render(<Agent params={{ name: "coder" }} />);
    expect(html).toContain(
      '>Tools</span><span class="rows-hint cut">300 tokens<',
    );
    expect(html).toContain(">datetime<");
    expect(html).toContain(">websearch<");
    expect(html).toContain('class="rows-meta">exa<');
    expect(html).not.toContain("people-prompt");

    path.value = "/agents/coder/skills";
    html = render(<Agent params={{ name: "coder" }} />);
    expect(html).toContain(
      '>Skills</span><span class="rows-hint cut">2K tokens<',
    );
    expect(html).toContain(">timoni<");
    // the description under the name, the fetch time at the row's end
    expect(html).toContain('class="rows-sub">Deploy with Timoni.<');
    expect(html).toContain('class="rows-meta">fetched 2h ago<');

    path.value = "/agents/coder/mcp";
    html = render(<Agent params={{ name: "coder" }} />);
    expect(html).toContain("No MCP servers.");
    expect(html).toContain(
      'class="tabs-tab tabs-tab-on" href="/agents/coder/mcp" aria-current="page">MCP<',
    );
  });

  test.serial("Agent draws its activity ghost, then its days", () => {
    agentPage.value = agent;
    let html = render(<Agent params={{ name: "coder" }} />);
    expect(html).toContain('aria-label="Loading activity"');
    // another agent's days are not this one's
    agentDays.value = { name: "writer", body: days };
    html = render(<Agent params={{ name: "coder" }} />);
    expect(html).toContain('aria-label="Loading activity"');

    agentDays.value = { name: "coder", body: days };
    html = render(<Agent params={{ name: "coder" }} />);
    expect(html).not.toContain('aria-label="Loading activity"');
    expect(html).toContain(">3 turns · 4K tokens<");
    expect(html).toContain(
      'data-index="1" class="activity-cell activity-level-4"',
    );

    agentDays.value = null;
    agentDaysFailed.value = true;
    html = render(<Agent params={{ name: "coder" }} />);
    expect(html).not.toContain(">Activity<");
    expect(html).toContain(">Instructions<");
  });

  test.serial("Agent without tools says why", () => {
    agentPage.value = {
      ...agent,
      agent: {
        ...agent.agent,
        prompt: "",
        model: { ...agent.agent.model, tools: false },
      },
      skills: [],
      tools: [],
    };
    expect(render(<Agent params={{ name: "coder" }} />)).toContain(
      "No instructions.",
    );
    path.value = "/agents/coder/tools";
    expect(render(<Agent params={{ name: "coder" }} />)).toContain(
      "The model does not take tools.",
    );
    path.value = "/agents/coder/skills";
    expect(render(<Agent params={{ name: "coder" }} />)).toContain(
      "No skills.",
    );
    path.value = "/agents/coder/mcp";
    expect(render(<Agent params={{ name: "coder" }} />)).toContain(
      "The model does not take tools.",
    );
  });
});

describe("the agent page's words", () => {
  test("a tab is found by its address, the prompt's for any other", () => {
    expect(agentTab("/agents/coder", "coder")).toBe(0);
    expect(agentTab("/agents/coder/tools", "coder")).toBe(1);
    expect(agentTab("/agents/coder/skills", "coder")).toBe(2);
    expect(agentTab("/agents/coder/mcp", "coder")).toBe(3);
    expect(agentTab("/agents/coder/nope", "coder")).toBe(0);
    expect(agentTab("/agents/writer/mcp", "coder")).toBe(0);
  });

  test("the tabs count the tools, the skills and the servers", () => {
    expect(
      agentTabs("coder", agent).map((t) => [t.label, t.href, t.count]),
    ).toEqual([
      ["Instructions", "/agents/coder", undefined],
      ["Tools", "/agents/coder/tools", 2],
      ["Skills", "/agents/coder/skills", 1],
      ["MCP", "/agents/coder/mcp", 0],
    ]);
  });

  test("the days are one series keyed by the agent", () => {
    expect(agentAnswer(days, "a1")).toEqual({
      since: days.since,
      until: days.until,
      days: days.days,
      total: days.total,
      projects: [{ projectId: "a1", usage: days.usage }],
    });
  });
});
