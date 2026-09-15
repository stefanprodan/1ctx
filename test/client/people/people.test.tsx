// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page and an agent's page render what the directory answered,
// and their words come from People.model.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  agentPage,
  agentPageError,
  loadAgentPage,
  loadPerson,
  person,
  personError,
} from "../../../src/client/data/directory.ts";
import { me } from "../../../src/client/data/me.ts";
import { agentHref, userHref } from "../../../src/client/lib/hrefs.ts";
import { Agent } from "../../../src/client/views/people/Agent.tsx";
import {
  effortText,
  localTime,
  thinkingText,
  tokensText,
} from "../../../src/client/views/people/People.model.ts";
import { User } from "../../../src/client/views/people/User.tsx";
import type {
  DirectoryAgentResponse,
  DirectoryUserResponse,
} from "../../../src/shared/api/directory.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const caelea: Me = {
  id: "u1",
  username: "caelea",
  fullName: "Oana Mangiurea",
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
    },
    thinking: "on",
    effort: "high",
    prompt: "You write code.\nSmall diffs.",
    skills: ["s1"],
    servers: [],
    mcpMode: "auto",
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
  mcp: { mode: "auto", resolved: "all", servers: [], tokens: 0, cap: 6000 },
  tokens: { prompt: 7, skills: 2000, tools: 300 },
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  me.value = caelea;
  person.value = null;
  personError.value = null;
  agentPage.value = null;
  agentPageError.value = null;
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
    const pending = loadPerson("elena");
    expect(person.value).toBeNull();
    gates[0]();
    await pending;
    expect(person.value?.user.username).toBe("elena");
  });

  test.serial(
    "an answer that lands after the user changed is dropped",
    async () => {
      const gates = gated((name) => Response.json(personOf(name)));
      const pending = loadPerson("bogdan");
      me.value = { ...caelea, id: "u9", username: "someone" };
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

describe("People.model", () => {
  test("the addresses of both pages", () => {
    expect(userHref("caelea")).toBe("/users/caelea");
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
    expect(tokensText(2716)).toBe("2.72k tokens");
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
      const html = render(<User params={{ username: "bogdan" }} />);
      expect(html).toContain(">Bogdan P<");
      expect(html).toContain('class="people-meta people-handle">@bogdan<');
      expect(html).toContain(">Disabled<");
      expect(html).toContain('href="mailto:bogdan@example.com"');
      expect(html).toContain(">Head of SRE.<");
      expect(html).toContain(">Projects in common<");
      expect(html).toContain('href="/projects/p2"');
      expect(html).toContain("12 September 2026");
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
        username: "caelea",
        fullName: "Oana Mangiurea",
        role: "member",
        email: "caelea@example.com",
        tz: "UTC",
        about: "",
        createdAt: 0,
        disabled: false,
      },
      projects: [],
    };
    const html = render(<User params={{ username: "caelea" }} />);
    expect(html).toContain(">Your team projects<");
    expect(html).toContain("No team projects yet.");
    expect(html).toContain("Nothing written yet.");
  });

  test.serial(
    "Agent shows the model, the prompt, the skills and the tools",
    () => {
      agentPage.value = agent;
      const html = render(<Agent params={{ name: "coder" }} />);
      expect(html).toContain("deepseek/deepseek-v4-flash");
      expect(html).toContain(
        "router · 128k · $0.14 / $0.28 · tools · reasoning",
      );
      expect(html).toContain(
        'class="people-prompt-text people-prompt-cut">You write code.\nSmall diffs.<',
      );
      expect(html).toContain(
        'class="label">Prompt</span><span class="rows-hint">7 tokens<',
      );
      expect(html).toContain(
        'class="label">Skills</span><span class="rows-hint">2k tokens<',
      );
      expect(html).toContain(
        'class="label">Tools</span><span class="rows-hint">300 tokens<',
      );
      expect(html).toContain(">timoni<");
      // the description under the name, the fetch time at the row's end
      expect(html).toContain('class="rows-sub">Deploy with Timoni.<');
      expect(html).toContain('class="rows-meta">fetched 2h ago<');
      expect(html).toContain(">datetime<");
      expect(html).toContain(">websearch<");
      expect(html).toContain('class="rows-meta">exa<');
      // the skill's fetch time and websearch's provider, no size on a row
      expect(html.match(/class="rows-meta"/g)).toHaveLength(2);
      expect(html).toContain(">high<");
    },
  );

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
    const html = render(<Agent params={{ name: "coder" }} />);
    expect(html).toContain("The model does not take tools.");
    expect(html).toContain("No skills.");
    expect(html).toContain("No prompt.");
  });
});
