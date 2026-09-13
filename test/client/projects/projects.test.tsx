// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The projects entity follows the signed-in user, the rail lists the
// projects under Projects, and the two pages render their rows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Rail } from "../../../src/client/app/Rail.tsx";
import { path } from "../../../src/client/app/router.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  loadProject,
  loadProjects,
  project,
  projectError,
  projects,
  projectsError,
} from "../../../src/client/data/projects.ts";
import { projectAgents } from "../../../src/client/data/sessions.ts";
import { Members } from "../../../src/client/views/projects/Members.tsx";
import {
  kindLine,
  kindText,
} from "../../../src/client/views/projects/Project.model.ts";
import { Project } from "../../../src/client/views/projects/Project.tsx";
import { Projects } from "../../../src/client/views/projects/Projects.tsx";
import type { UserSummary } from "../../../src/shared/contracts/user.ts";

const oana: UserSummary = {
  id: "u1",
  username: "oana",
  fullName: "Oana Pellea",
  role: "member",
};
const personal = { id: "p1", kind: "personal" as const, name: "oana" };

const realFetch = globalThis.fetch;
let answer: () => unknown;

beforeEach(() => {
  me.value = oana;
  projects.value = null;
  project.value = null;
  globalThis.fetch = (async () =>
    Response.json(answer())) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the projects entity", () => {
  test("keeps the list for the user it was loaded for", async () => {
    answer = () => ({ projects: [personal] });
    await loadProjects();
    expect(projects.value).toEqual([personal]);
  });

  test("drops the list with the signed-in user", async () => {
    projects.value = [personal];
    project.value = { ...personal, createdAt: 0, members: [oana] };
    me.value = null;
    expect(projects.value).toBeNull();
    expect(project.value).toBeNull();
  });

  test("drops a list that answers after another user signed in", async () => {
    answer = () => {
      me.value = { ...oana, id: "u2", username: "admin" };
      return { projects: [personal] };
    };
    await loadProjects();
    expect(projects.value).toBeNull();
  });

  test("drops a failure that answers after another user signed in", async () => {
    globalThis.fetch = (async () => {
      me.value = { ...oana, id: "u2", username: "admin" };
      return Response.json({ error: "gone" }, { status: 500 });
    }) as unknown as typeof fetch;
    await loadProjects();
    expect(projectsError.value).toBeNull();
  });

  test("two askers at once share one request", async () => {
    let calls = 0;
    answer = () => {
      calls++;
      return { projects: [personal] };
    };
    await Promise.all([loadProjects(), loadProjects()]);
    expect(calls).toBe(1);
    expect(projects.value).toEqual([personal]);
  });

  test("an older project answer never overwrites a newer one", async () => {
    const gates: (() => void)[] = [];
    globalThis.fetch = ((url: string) =>
      new Promise((resolve) => {
        const id = url.split("/").pop();
        gates.push(() =>
          resolve(
            Response.json({
              project: { ...personal, id, name: id, createdAt: 0, members: [] },
            }),
          ),
        );
      })) as unknown as typeof fetch;
    const first = loadProject("p1");
    const second = loadProject("p2");
    // the first answers last
    gates[1]();
    await second;
    expect(project.value?.id).toBe("p2");
    gates[0]();
    await first;
    expect(project.value?.id).toBe("p2");
  });

  test("a failure of an older project request is dropped", async () => {
    const gates: (() => void)[] = [];
    globalThis.fetch = ((url: string) =>
      new Promise((resolve) => {
        const id = url.split("/").pop();
        gates.push(() =>
          resolve(
            id === "p1"
              ? Response.json({ error: "no such project" }, { status: 404 })
              : Response.json({
                  project: { ...personal, id, createdAt: 0, members: [] },
                }),
          ),
        );
      })) as unknown as typeof fetch;
    const first = loadProject("p1");
    const second = loadProject("p2");
    gates[1]();
    await second;
    gates[0]();
    await first;
    expect(projectError.value).toBeNull();
    expect(project.value?.id).toBe("p2");
  });
});

describe("the rail", () => {
  test("lists the projects under Projects", () => {
    projects.value = [personal, { id: "p2", kind: "team", name: "ops" }];
    const html = render(<Rail user={oana} narrow={false} onHide={() => {}} />);
    expect(html).toContain('href="/projects"');
    expect(html.indexOf('href="/projects/p1"')).toBeLessThan(
      html.indexOf('href="/projects/p2"'),
    );
    expect(html).toContain('href="/projects/p1" class="rail-sub">oana<');
  });

  test("marks the project on screen as the current page", () => {
    projects.value = [personal];
    path.value = "/projects/p1";
    const html = render(<Rail user={oana} narrow={false} onHide={() => {}} />);
    expect(html).toContain('class="rail-sub rail-sub-on" aria-current="page"');
    path.value = "/";
  });
});

describe("Project.model", () => {
  test("the words for a kind", () => {
    expect(kindLine("personal")).toBe("personal");
    expect(kindLine("team")).toBe("team");
    expect(kindText("personal")).toContain("yours alone");
    expect(kindText("team")).toContain("Every member");
  });
});

describe("the pages", () => {
  test("Projects renders a row per project", () => {
    projects.value = [personal];
    const html = render(<Projects />);
    expect(html).toContain('class="projects-row" href="/projects/p1"');
    expect(html).toContain(">oana<");
    expect(html).toContain(">personal<");
  });

  test("Project renders the feed of the project on screen only", () => {
    project.value = { ...personal, createdAt: 0, members: [oana] };
    const html = render(<Project params={{ id: "p1" }} />);
    expect(html).toContain("yours alone");
    expect(html).toContain("1 user</a>");
    expect(html).not.toContain("Oana Pellea");
    expect(html).toContain('href="/projects/p1/members"');
    expect(html).toContain('class="tabs-tab tabs-tab-on" href="/projects/p1"');
    expect(html).toContain('placeholder="Search sessions"');
    expect(html).not.toContain("@oana");
    expect(render(<Project params={{ id: "p9" }} />)).toContain("Loading");
  });

  test("Members renders the users and the agents of the project", () => {
    project.value = { ...personal, createdAt: 0, members: [oana] };
    projectAgents.value = null;
    let html = render(<Members params={{ id: "p1" }} />);
    expect(html).toContain(
      'class="tabs-tab tabs-tab-on" href="/projects/p1/members"',
    );
    expect(html).toContain('<span class="tabs-count">1</span>');
    expect(html).toContain('class="projects-avatar">OP<');
    expect(html).toContain("@oana");
    expect(html).toContain("Loading");
    projectAgents.value = [
      {
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
        thinking: null,
        effort: null,
        prompt: "",
        createdAt: 0,
      } as never,
    ];
    html = render(<Members params={{ id: "p1" }} />);
    expect(html).toContain('class="agent-row-name">coder<');
    expect(html).toContain("deepseek/deepseek-v4-flash");
    // no provider name for a member, and no form to open
    expect(html).toContain(
      'class="agent-row-meta">128k · $0.14 / $0.28 · tools · reasoning<',
    );
    expect(html).not.toContain("agents-row");
    projectAgents.value = [];
    expect(render(<Members params={{ id: "p1" }} />)).toContain(
      "No agents yet",
    );
  });

  test("Project heads with the name from the list while loading", () => {
    projects.value = [{ id: "p9", kind: "team", name: "ops" }];
    const html = render(<Project params={{ id: "p9" }} />);
    expect(html).toContain('class="page-crumb-on">ops<');
    expect(html).toContain("Loading");
  });
});
