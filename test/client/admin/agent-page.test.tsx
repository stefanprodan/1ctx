// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { query } from "../../../src/client/app/router.ts";
import { agents } from "../../../src/client/data/agents.ts";
import { servers } from "../../../src/client/data/mcp.ts";
import { providers } from "../../../src/client/data/providers.ts";
import { skills } from "../../../src/client/data/skills.ts";
import { AgentGeneral } from "../../../src/client/views/admin/AgentGeneral.tsx";
import { AgentMcp } from "../../../src/client/views/admin/AgentMcp.tsx";
import {
  cardBody,
  cardFieldOf,
  deleteLine,
  failing,
  failingLine,
  lastUse,
  nameTaken,
} from "../../../src/client/views/admin/AgentPage.model.ts";
import { AgentDrafts } from "../../../src/client/views/admin/AgentPage.state.ts";
import { tabOf } from "../../../src/client/views/admin/AgentPage.tsx";
import { AgentSkills } from "../../../src/client/views/admin/AgentSkills.tsx";
import { NewAgent } from "../../../src/client/views/admin/NewAgent.tsx";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";
import type {
  CatalogMatch,
  ProviderSummary,
} from "../../../src/shared/contracts/provider.ts";
import type { SkillSummary } from "../../../src/shared/contracts/skill.ts";

const described: CatalogMatch = {
  id: "vendor/flash",
  name: "Flash",
  contextLength: 128000,
  promptPrice: 0.14,
  completionPrice: 0.28,
  tools: true,
  reasoning: true,
  thinkingRequired: false,
  reasoningKnown: true,
  described: true,
};
// a model a catalog of ids alone lists: its window and tools are stated
const stated: CatalogMatch = {
  id: "local/model",
  name: "local/model",
  contextLength: 32768,
  promptPrice: null,
  completionPrice: null,
  tools: true,
  reasoning: false,
  thinkingRequired: false,
  reasoningKnown: false,
  described: false,
};
const agent: AgentSummary = {
  id: "ag1",
  name: "coder",
  avatar: "bot",
  providerId: "pr1",
  model: described,
  thinking: "on",
  effort: "high",
  prompt: "Be brief.",
  skills: ["sk1", "sk2"],
  servers: [{ serverId: "s1", read: true, write: false }],
  mcpMode: "auto",
  upstream: "vendor/fp8",
  default: false,
  createdAt: 0,
};
const provider: ProviderSummary = {
  id: "pr1",
  name: "router",
  wire: "openrouter",
  baseUrl: "http://models.test/v1",
  keyName: "provider-router",
  hasKey: false,
  createdAt: 0,
};
const skill: SkillSummary = {
  id: "sk1",
  name: "gitops",
  description: "Flux expert.",
  license: "",
  compatibility: "",
  metadata: {},
  allowedTools: "",
  sourceKind: "file",
  sourceUrl: "https://skills.test/gitops",
  sourceSelect: "",
  sourceDigest: "",
  digest: "",
  bodyBytes: 0,
  files: [],
  dropped: [],
  droppedMore: 0,
  fetchedAt: 0,
  lastChange: null,
  refreshError: null,
  refreshFailedAt: null,
  agents: [],
  createdAt: 0,
};
const rows = {
  skills: [{ id: "sk1" }, { id: "sk2" }],
  servers: [{ id: "s1" }],
};

describe("a card's body", () => {
  test("is the saved agent with only the card's fields changed", () => {
    const body = cardBody(agent, { name: "writer" }, rows);
    expect(body).toEqual({
      name: "writer",
      avatar: "bot",
      providerId: "pr1",
      model: "vendor/flash",
      thinking: "on",
      effort: "high",
      prompt: "Be brief.",
      skills: ["sk1", "sk2"],
      servers: [{ serverId: "s1", read: true, write: false }],
      mcpMode: "auto",
      upstream: "vendor/fp8",
    });
    expect(body).not.toHaveProperty("contextLength");
    expect(body).not.toHaveProperty("default");
  });

  test("carries a stated window and tools on every other card's save", () => {
    const local = { ...agent, model: stated };
    expect(cardBody(local, { prompt: "x" }, rows)).toMatchObject({
      contextLength: 32768,
      tools: true,
    });
  });

  test("drops the stated facts when a described model is picked", () => {
    const local = { ...agent, model: stated };
    const body = cardBody(local, { model: described.id }, rows);
    expect(body).not.toHaveProperty("contextLength");
    expect(body).not.toHaveProperty("tools");
    const again = cardBody(
      local,
      { model: "local/other", contextLength: 8192, tools: false },
      rows,
    );
    expect(again).toMatchObject({ contextLength: 8192, tools: false });
  });

  test("leaves out a skill or a server deleted since the page loaded", () => {
    const body = cardBody(
      agent,
      { name: "x" },
      {
        skills: [{ id: "sk2" }],
        servers: [],
      },
    );
    expect(body.skills).toEqual(["sk2"]);
    expect(body.servers).toEqual([]);
    // a list that did not load keeps the picks as they are
    expect(cardBody(agent, {}, { skills: null, servers: null }).skills).toEqual(
      ["sk1", "sk2"],
    );
  });
});

test("a refusal lands on a field only when the card draws it", () => {
  const general = cardFieldOf(["name", "prompt"]);
  expect(general("an agent named coder exists")).toBe("name");
  expect(general("router does not list vendor/flash")).toBeUndefined();
  expect(cardFieldOf(["model"])("router does not list vendor/flash")).toBe(
    "model",
  );
  expect(cardFieldOf([])("no such skill sk3")).toBeUndefined();
});

test("the last use says running, when it ran, or never", () => {
  const now = 10 * 60_000;
  expect(lastUse(undefined, now)).toEqual({
    text: "never ran",
    running: false,
  });
  expect(lastUse({ agentId: "ag1", lastAt: 0, running: true }, now)).toEqual({
    text: "running",
    running: true,
  });
  expect(lastUse({ agentId: "ag1", lastAt: 0, running: false }, now).text).toBe(
    "ran 10m ago",
  );
});

test("what is failing counts the agent's own servers and skills", () => {
  const counts = failing(
    agent,
    [
      { id: "s1", refreshFailedAt: 5 },
      { id: "s2", refreshFailedAt: 5 },
    ],
    [
      { id: "sk1", refreshFailedAt: 5 },
      { id: "sk2", refreshFailedAt: null },
    ],
  );
  expect(counts).toEqual({ servers: 1, skills: 1 });
  expect(failingLine(counts)).toBe("1 MCP server, 1 skill failing");
  expect(failingLine({ servers: 5, skills: 3 })).toBe(
    "5 MCP servers, 3 skills failing",
  );
  expect(failingLine({ servers: 0, skills: 2 })).toBe("2 skills failing");
  expect(failingLine({ servers: 0, skills: 0 })).toBe("");
  expect(failing(agent, null, null)).toEqual({ servers: 0, skills: 0 });
});

test("the Delete line says only the parts that apply", () => {
  expect(deleteLine({ chats: 18, automations: 1, running: 0 })).toBe(
    "Archives its 18 chats and pauses 1 scheduled task. This cannot be undone.",
  );
  expect(deleteLine({ chats: 1, automations: 0, running: 2 })).toBe(
    "Archives its 1 chat. Stops the 2 running now. This cannot be undone.",
  );
  expect(deleteLine({ chats: 0, automations: 2, running: 0 })).toBe(
    "Pauses 2 scheduled tasks. This cannot be undone.",
  );
  expect(deleteLine({ chats: 0, automations: 0, running: 0 })).toBe(
    "This cannot be undone.",
  );
  expect(deleteLine(null)).toBe("This cannot be undone.");
});

test("a name is taken by another agent only", () => {
  const list = [agent, { ...agent, id: "ag2", name: "writer" }];
  expect(nameTaken("writer", list, "ag1")).toBe(true);
  expect(nameTaken(" coder ", list, "ag1")).toBe(false);
  expect(nameTaken("writer", null, "ag1")).toBe(false);
});

test("the tab is the address's last step", () => {
  expect(tabOf("/admin/config/agents/coder")).toBe("general");
  expect(tabOf("/admin/config/agents/coder/model")).toBe("general");
  expect(tabOf("/admin/config/agents/mcp")).toBe("general");
  expect(tabOf("/admin/config/agents/coder/mcp")).toBe("mcp");
});

describe("the model draft", () => {
  test("Cancel puts back what Change found, a provider change included", () => {
    const d = AgentDrafts.of(agent);
    d.change();
    d.chooseProvider("pr2");
    expect(d.model.value).toBeNull();
    expect(d.effort.value).toBeNull();
    expect(d.upstream.value).toBeNull();
    d.cancel();
    expect(d.changing.value).toBe(false);
    expect(d.providerId.value).toBe("pr1");
    expect(d.model.value).toBe(described);
    expect(d.effort.value).toBe("high");
    expect(d.upstream.value).toBe("vendor/fp8");
  });

  test("a pick clears what belonged to another model", () => {
    const d = AgentDrafts.of({ ...agent, model: stated });
    d.change();
    d.pick(described, true);
    expect(d.changing.value).toBe(false);
    expect(d.upstream.value).toBeNull();
    expect(d.thinking.value).toBeNull();
    expect(d.windowText.value).toBe("");
    expect(d.takesTools.value).toBe(false);
    // the same model again keeps the preferred provider chosen for it
    const same = AgentDrafts.of(agent);
    same.pick(described, false);
    expect(same.upstream.value).toBe("vendor/fp8");
    expect(same.thinking.value).toBe("on");
  });

  test("a new agent's draft opens the search with nothing to cancel to", () => {
    const d = AgentDrafts.blank("pr1");
    expect(d.changing.value).toBe(true);
    expect(d.cancellable).toBe(false);
    expect(d.modelProblem()?.field).toBe("model");
    d.pick(described, false);
    d.change();
    expect(d.cancellable).toBe(true);
    d.cancel();
    expect(d.model.value).toBe(described);
    expect(d.modelBody("openrouter")).toEqual({
      providerId: "pr1",
      model: "vendor/flash",
      thinking: null,
      effort: null,
      upstream: null,
    });
  });

  test("a window the model cannot take is an edit, so Save can refuse it", () => {
    // no window saved: a bad one reads as none, the same as the row
    const row: AgentSummary = {
      ...agent,
      model: { ...stated, contextLength: null, tools: false },
      effort: null,
      upstream: null,
    };
    const d = AgentDrafts.of(row);
    expect(d.modelDirty(row, "openai-compatible")).toBe(false);
    d.windowText.value = "999999999999";
    expect(d.modelDirty(row, "openai-compatible")).toBe(true);
    d.windowText.value = "";
    expect(d.modelDirty(row, "openai-compatible")).toBe(false);
  });

  test("a card's save holds every card until it answers", async () => {
    const d = AgentDrafts.of(agent);
    let release = () => {};
    const run = d.save(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(d.saving.value).toBe(true);
    release();
    await run;
    expect(d.saving.value).toBe(false);
    await expect(
      d.save(() => Promise.reject(new Error("refused"))),
    ).rejects.toThrow("refused");
    expect(d.saving.value).toBe(false);
  });

  test("an untouched model draft follows the row another card saved", () => {
    const d = AgentDrafts.of(agent);
    const fresher = { ...agent, model: { ...described, contextLength: 1 } };
    d.follow(agent, fresher);
    expect(d.model.value).toBe(fresher.model);
    // an edited one stays
    d.thinking.value = "off";
    const again = { ...fresher, model: { ...described } };
    d.follow(fresher, again);
    expect(d.model.value).toBe(fresher.model);
    expect(d.thinking.value).toBe("off");
  });

  test("an untouched card follows the mark and the name moved under it", () => {
    const marked = { ...agent, default: true };
    const d = AgentDrafts.of(marked);
    const moved = { ...marked, default: false, name: "writer" };
    d.follow(marked, moved);
    expect(d.isDefault.value).toBe(false);
    expect(d.name.value).toBe("writer");
    expect(d.generalDirty(moved)).toBe(false);
    // an edited name and the skills it picked stay
    d.name.value = "editor";
    d.skills.value = ["sk1"];
    const again = { ...moved, name: "other", skills: ["sk2"] };
    d.follow(moved, again);
    expect(d.name.value).toBe("editor");
    expect(d.skills.value).toEqual(["sk1"]);
    // an untouched list follows
    const d2 = AgentDrafts.of(agent);
    d2.follow(agent, { ...agent, skills: ["sk2"], mcpMode: "catalog" });
    expect(d2.skills.value).toEqual(["sk2"]);
    expect(d2.mode.value).toBe("catalog");
  });

  test("a draft is dirty against the saved row, trimmed", () => {
    const d = AgentDrafts.of(agent);
    d.name.value = " coder ";
    expect(d.generalDirty(agent)).toBe(false);
    d.isDefault.value = true;
    expect(d.generalDirty(agent)).toBe(true);
    d.resetGeneral(agent);
    expect(d.isDefault.value).toBe(false);
    d.skills.value = ["sk2", "sk1"];
    expect(d.skillsDirty(agent)).toBe(false);
    d.servers.value = [{ serverId: "s1", read: true, write: true }];
    expect(d.serversDirty(agent)).toBe(true);
  });
});

describe("the cards", () => {
  test.serial("the oldest, while it is the default, keeps the mark", () => {
    providers.value = [];
    const oldest = { ...agent, default: true };
    const other = { ...agent, id: "ag9", name: "other", createdAt: 9 };
    agents.value = [oldest, other];
    const kept = render(
      <AgentGeneral agent={oldest} drafts={AgentDrafts.of(oldest)} />,
    );
    expect(kept).toContain("Mark another agent to move it");
    expect(kept).toMatch(
      /<input type="checkbox"[^>]*name="default"[^>]*disabled/,
    );
    agents.value = [other, oldest];
    expect(
      render(<AgentGeneral agent={oldest} drafts={AgentDrafts.of(oldest)} />),
    ).not.toContain("Mark another agent");
    agents.value = null;
  });

  // a Save is the foot's submit, so each card that drafts is a form
  test.serial("every Save submits a form", () => {
    providers.value = [];
    skills.value = [skill];
    servers.value = [];
    const d = AgentDrafts.of(agent);
    for (const card of [
      <AgentGeneral key="g" agent={agent} drafts={d} />,
      <AgentSkills key="s" agent={agent} drafts={d} />,
      <AgentMcp key="m" agent={agent} drafts={d} />,
    ]) {
      const html = render(card);
      const forms = html.split("<form").slice(1);
      const submits = (html.match(/type="submit"/g) ?? []).length;
      expect(submits).toBeGreaterThan(0);
      expect(
        forms.reduce(
          (n, f) =>
            n + (f.split("</form>")[0]!.match(/type="submit"/g) ?? []).length,
          0,
        ),
      ).toBe(submits);
    }
    providers.value = null;
    skills.value = null;
    servers.value = null;
  });

  test.serial("a model that takes no tools gets no skills to add", () => {
    skills.value = [skill];
    const bare = { ...agent, model: { ...described, tools: false } };
    const html = render(
      <AgentSkills agent={bare} drafts={AgentDrafts.of(bare)} />,
    );
    expect(html).toContain("This model takes no tools.");
    expect(html).not.toContain("Add skill");
    expect(html).not.toContain('type="submit"');
    const tools = render(
      <AgentSkills agent={agent} drafts={AgentDrafts.of(agent)} />,
    );
    expect(tools).toContain("Add skill");
    expect(tools).not.toContain("takes no tools");
    skills.value = null;
  });

  test.serial("New agent is one form whose one submit is Create", () => {
    providers.value = [provider];
    const html = render(<NewAgent />);
    const submits = html.match(/type="submit"/g) ?? [];
    expect(submits.length).toBe(1);
    expect(html.split("<form").length).toBe(2);
    expect(html).toContain("Create agent");
    expect(html).not.toContain("Default for new users");
    expect(html).toContain('name="model"');
    expect(html).not.toContain(">Cancel</button>");
    providers.value = [];
    expect(render(<NewAgent />)).toContain("Add a provider");
    providers.value = null;
  });

  test.serial("New agent opens on the provider its link names", () => {
    const other = { ...provider, id: "pr9", name: "zeta" };
    providers.value = [provider, other];
    query.value = "?new&provider=zeta";
    try {
      const html = render(<NewAgent />);
      expect(html).toContain('class="model-picker-provider" title="zeta"');
      // Cancel returns to the provider's page
      expect(html).toContain('href="/admin/config/providers/zeta">Cancel<');
    } finally {
      query.value = "";
      providers.value = null;
    }
  });
});
