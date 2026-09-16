// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The projects entity follows the signed-in user, the rail lists the
// projects under Projects, and the two pages render their rows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { projectHere } from "../../../src/client/app/Rail.model.ts";
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
  savePersonalProject,
} from "../../../src/client/data/projects.ts";
import {
  loadProjectAgents,
  projectAgentCount,
  projectAgents,
} from "../../../src/client/data/sessions.ts";
import { Members } from "../../../src/client/views/projects/Members.tsx";
import {
  aboutLine,
  listedProjects,
  peopleLine,
  tabsOf,
} from "../../../src/client/views/projects/Project.model.ts";
import { Project } from "../../../src/client/views/projects/Project.tsx";
import { Projects } from "../../../src/client/views/projects/Projects.tsx";
import { Settings } from "../../../src/client/views/projects/Settings.tsx";
import type { Me } from "../../../src/shared/contracts/user.ts";

const caelea: Me = {
  id: "u1",
  username: "caelea",
  fullName: "Oana Mangiurea",
  role: "member",
  mustChangePassword: false,
};
const personal = {
  id: "p1",
  kind: "personal" as const,
  name: "personal",
  createdAt: 0,
  memberCount: 1,
};

const realFetch = globalThis.fetch;
let answer: () => unknown;

beforeEach(() => {
  me.value = caelea;
  projects.value = null;
  project.value = null;
  globalThis.fetch = (async () =>
    Response.json(answer())) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the projects entity", () => {
  test.serial(
    "a save replaces the project and clears a stale failure",
    async () => {
      const saved = {
        ...personal,
        description: "Scratch work",
        chats: 0,
        members: [caelea],
      };
      project.value = { ...saved, description: "" };
      projectError.value = { words: "stale failure", status: 500 };
      answer = () => ({ project: saved, projects: [saved] });
      await savePersonalProject({ description: "Scratch work" });
      expect(project.value).toEqual(saved);
      expect(projectError.value).toBeNull();
    },
  );

  test("keeps the list for the user it was loaded for", async () => {
    answer = () => ({ projects: [personal] });
    await loadProjects();
    expect(projects.value).toEqual([personal]);
  });

  test.serial("an agent count belongs only to the project loaded", async () => {
    answer = () => ({ agents: [] });
    await loadProjectAgents("p1");
    expect(projectAgentCount("p1")).toBe(0);

    let release: (response: Response) => void = () => {};
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;
    const pending = loadProjectAgents("p2");
    expect(projectAgentCount("p1")).toBeNull();
    expect(projectAgentCount("p2")).toBeNull();
    release(Response.json({ agents: [{}] }));
    await pending;
    expect(projectAgentCount("p2")).toBe(1);
    me.value = null;
  });

  test("drops the list with the signed-in user", async () => {
    projects.value = [personal];
    project.value = {
      ...personal,
      createdAt: 0,
      description: "",
      chats: 0,
      members: [caelea],
    };
    me.value = null;
    expect(projects.value).toBeNull();
    expect(project.value).toBeNull();
  });

  test.serial(
    "drops a list that answers after another user signed in",
    async () => {
      answer = () => {
        me.value = { ...caelea, id: "u2", username: "admin" };
        return { projects: [personal] };
      };
      await loadProjects();
      expect(projects.value).toBeNull();
    },
  );

  test.serial(
    "drops a failure that answers after another user signed in",
    async () => {
      globalThis.fetch = (async () => {
        me.value = { ...caelea, id: "u2", username: "admin" };
        return Response.json({ error: "gone" }, { status: 500 });
      }) as unknown as typeof fetch;
      await loadProjects();
      expect(projectsError.value).toBeNull();
    },
  );

  test("an older list answer never overwrites a newer one", async () => {
    const gates: ((rows: (typeof personal)[]) => void)[] = [];
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        gates.push((rows) => resolve(Response.json({ projects: rows })));
      })) as unknown as typeof fetch;
    const newer = { ...personal, name: "current" };
    const first = loadProjects();
    const second = loadProjects();
    gates[1]([newer]);
    await second;
    gates[0]([personal]);
    await first;
    expect(projects.value).toEqual([newer]);
  });

  test("an older project answer never overwrites a newer one", async () => {
    const gates: (() => void)[] = [];
    globalThis.fetch = ((url: string) =>
      new Promise((resolve) => {
        const id = url.split("/").pop();
        gates.push(() =>
          resolve(
            Response.json({
              project: {
                ...personal,
                id,
                name: id,
                createdAt: 0,
                description: "",
                chats: 0,
                members: [],
              },
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
                  project: {
                    ...personal,
                    id,
                    createdAt: 0,
                    description: "",
                    chats: 0,
                    members: [],
                  },
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
    projects.value = [
      personal,
      { id: "p2", kind: "team", name: "ops", createdAt: 0, memberCount: 1 },
    ];
    const html = render(
      <Rail user={caelea} narrow={false} onHide={() => {}} />,
    );
    expect(html).toContain('href="/projects"');
    expect(html.indexOf('href="/projects/p1"')).toBeLessThan(
      html.indexOf('href="/projects/p2"'),
    );
    expect(html).toContain(
      'href="/projects/p1" class="rail-sub rail-sub-icon">',
    );
    expect(html).toContain('class="rail-sub-name">personal<');
    // the personal project wears the lock, a team one the hash
    expect(html).toContain('d="M4.5 7.5h7');
    expect(html).toContain('d="M6.5 2.5 5 13.5');
  });

  test("marks the project on screen as the current page", () => {
    projects.value = [personal];
    path.value = "/projects/p1";
    const html = render(
      <Rail user={caelea} narrow={false} onHide={() => {}} />,
    );
    expect(html).toContain(
      'class="rail-sub rail-sub-icon rail-sub-on" aria-current="page"',
    );
    path.value = "/";
  });

  test("keeps the project on inside its other pages", () => {
    projects.value = [personal];
    path.value = "/projects/p1/members";
    const html = render(
      <Rail user={caelea} narrow={false} onHide={() => {}} />,
    );
    expect(html).toContain(
      'href="/projects/p1" class="rail-sub rail-sub-icon rail-sub-on">',
    );
    path.value = "/";
  });

  test("the project a page is in", () => {
    const chat = { session: { id: "s1", projectId: "p2" } } as never;
    expect(projectHere("/projects/p1", null)).toBe("p1");
    expect(projectHere("/projects/p1/members", null)).toBe("p1");
    expect(projectHere("/chat/s1", chat)).toBe("p2");
    // a chat not loaded yet, or another one still held
    expect(projectHere("/chat/s1", null)).toBeNull();
    expect(projectHere("/chat/s9", chat)).toBeNull();
    expect(projectHere("/projects", null)).toBeNull();
    const task = { id: "au1", projectId: "p3" };
    expect(projectHere("/automations/au1", null, task)).toBe("p3");
    expect(projectHere("/automations/au1/edit", null, task)).toBe("p3");
    expect(projectHere("/automations/au1/memory", null, task)).toBe("p3");
    expect(projectHere("/automations/au9", null, task)).toBeNull();
    expect(projectHere("/", chat)).toBeNull();
  });
});

describe("Project.model", () => {
  test("the Projects card lists the personal first, narrowed by name", () => {
    const list = [
      { kind: "team" as const, name: "on-call" },
      { kind: "team" as const, name: "platform" },
      { kind: "personal" as const, name: "personal" },
    ];
    const names = (q: string) => listedProjects(list, q).map((p) => p.name);
    expect(names("")).toEqual(["personal", "on-call", "platform"]);
    expect(names("  ")).toEqual(["personal", "on-call", "platform"]);
    expect(names("ON")).toEqual(["personal", "on-call"]);
    expect(names("call ")).toEqual(["on-call"]);
    expect(names("ops")).toEqual([]);
  });

  test("the words on a project's row", () => {
    expect(peopleLine({ kind: "personal", memberCount: 1 })).toBe("only you");
    expect(peopleLine({ kind: "team", memberCount: 1 })).toBe("1 member");
    expect(peopleLine({ kind: "team", memberCount: 4 })).toBe("4 members");
  });

  test("a personal project has Settings where a team has Members", () => {
    expect(tabsOf("p1", "team").map((t) => t.label)).toEqual([
      "Feed",
      "Automations",
      "Memory",
      "Members",
    ]);
    expect(tabsOf("p1", "personal")[1]).toEqual({
      label: "Automations",
      href: "/projects/p1/automations",
    });
    expect(tabsOf("p1", "personal")[2]).toEqual({
      label: "Memory",
      href: "/projects/p1/memory",
    });
    expect(tabsOf("p1", "personal")[3]).toEqual({
      label: "Settings",
      href: "/projects/p1/settings",
    });
  });

  test("Automations counts its rows, Members the users and the agents", () => {
    const counts = { automations: 3, members: 4, agents: 5 };
    expect(tabsOf("p1", "team", counts).map((t) => t.count)).toEqual([
      undefined,
      3,
      undefined,
      9,
    ]);
    // Settings counts nothing
    expect(tabsOf("p1", "personal", counts).map((t) => t.count)).toEqual([
      undefined,
      3,
      undefined,
      undefined,
    ]);
    // a count not known yet is left out, never shown as zero
    expect(
      tabsOf("p1", "team", { automations: null, members: 4, agents: null }).map(
        (t) => t.count,
      ),
    ).toEqual([undefined, undefined, undefined]);
    expect(tabsOf("p1", "team", { ...counts, automations: 0 })[1]?.count).toBe(
      0,
    );
  });

  test("the About line is the description, or says what a personal one is", () => {
    expect(aboutLine({ kind: "team", description: "Pages" })).toBe("Pages");
    expect(aboutLine({ kind: "personal", description: "" })).toBe(
      "Your personal project",
    );
    expect(aboutLine({ kind: "team", description: "" })).toBeNull();
  });
});

describe("the pages", () => {
  test.serial(
    "Projects puts the personal project first in one card with the teams",
    () => {
      projects.value = [
        { id: "p2", kind: "team", name: "ops", createdAt: 0, memberCount: 3 },
        personal,
      ];
      const html = render(<Projects />);
      expect(html).toContain('class="rows-line rows-go" href="/projects/p1"');
      expect(html).toContain('class="rows-line rows-go" href="/projects/p2"');
      expect(html.match(/class="rows-card"/g)).toHaveLength(1);
      expect(html.indexOf('href="/projects/p1"')).toBeLessThan(
        html.indexOf('href="/projects/p2"'),
      );
      expect(html).toContain(">only you<");
      expect(html).toContain(">3 members<");
      // a member does not manage teams
      expect(html).not.toContain('href="/admin/projects"');
      me.value = { ...caelea, role: "admin" };
      expect(render(<Projects />)).toContain('href="/admin/projects"');
    },
  );

  test.serial("Projects heads its card with the search", () => {
    projects.value = [personal];
    const html = render(<Projects />);
    expect(html).toContain('aria-label="Projects"');
    expect(html).toContain('placeholder="Search projects"');
    expect(html).not.toContain("No projects found");
  });

  test.serial("Projects has Home's aside: the week and the agents", () => {
    projects.value = [personal];
    projectAgents.value = [];
    const html = render(<Projects />);
    expect(html).toContain('class="split-aside"');
    expect(html).toContain(">This week<");
    expect(html).toContain(">Agents<");
  });

  test.serial("Projects without a team holds the personal row alone", () => {
    projects.value = [personal];
    const html = render(<Projects />);
    expect(html.match(/class="rows-item"/g)).toHaveLength(1);
    expect(html).not.toContain("No team projects yet");
  });

  test("Project renders the feed of the project on screen only", () => {
    project.value = {
      ...personal,
      createdAt: 0,
      description: "",
      chats: 0,
      members: [caelea],
    };
    projectAgents.value = [];
    const html = render(<Project params={{ id: "p1" }} />);
    expect(html).toContain(
      '<div class="split-line">Your personal project</div>',
    );
    // the aside's second section is the project's activity, not its agents
    expect(html).not.toContain("No agents yet.");
    expect(html).toContain(">Activity<");
    expect(html).not.toContain("Members");
    expect(html).not.toContain('<div class="split-line">Chats');
    expect(html).toContain(
      'class="stream-filter stream-filter-on" aria-pressed="true">All<',
    );
    expect(html).toContain('href="/projects/p1/settings"');
    expect(html).toContain('class="tabs-tab tabs-tab-on" href="/projects/p1"');
    expect(html).toContain('placeholder="Search sessions"');
    expect(html).not.toContain("@caelea");
    projectAgents.value = null;
    expect(render(<Project params={{ id: "p1" }} />)).toContain(
      'placeholder="Start a chat in personal"',
    );
    expect(render(<Project params={{ id: "p9" }} />)).toContain("Loading");
  });

  test("the About card leads with a team project's description", () => {
    project.value = {
      ...personal,
      kind: "team",
      description: "Incidents and pages",
      chats: 12,
      members: [caelea],
    };
    let html = render(<Project params={{ id: "p1" }} />);
    expect(html).toContain('<div class="split-line">Incidents and pages</div>');
    // the members are the tab's; the aside shows the activity
    expect(html).not.toContain("1 user</a>");
    expect(html).toContain(">Activity<");
    expect(html).toContain('href="/projects/p1/members"');
    project.value = { ...project.value, description: "" };
    html = render(<Project params={{ id: "p1" }} />);
    expect(html).not.toContain("personal project");
  });

  test("Settings describes a personal project, a note for a team", () => {
    project.value = {
      ...personal,
      description: "Scratch work",
      chats: 0,
      members: [caelea],
    };
    let html = render(<Settings params={{ id: "p1" }} />);
    expect(html).toContain(
      'class="tabs-tab tabs-tab-on" href="/projects/p1/settings"',
    );
    // a personal project is always named personal, so no name field
    expect(html).not.toContain('name="name"');
    expect(html).toContain(">Scratch work</textarea>");
    expect(html).toContain("What agents should know about it.");
    expect(html).toContain('class="section-form"');
    project.value = { ...project.value, kind: "team" };
    html = render(<Settings params={{ id: "p1" }} />);
    // a team has no Settings tab, and Members is not the page shown
    expect(html).not.toContain("tabs-tab-on");
    expect(html).not.toContain('name="description"');
    expect(html).toContain("An admin manages a team project.");
  });

  test("Members of a personal project shows only the agents", () => {
    project.value = {
      ...personal,
      description: "",
      chats: 0,
      members: [caelea],
    };
    projectAgents.value = [];
    const html = render(<Members params={{ id: "p1" }} />);
    expect(html).not.toContain(">Users<");
    expect(html).toContain(">Agents<");
  });

  test.serial(
    "Members links each card to its admin page for an admin only",
    () => {
      project.value = {
        ...personal,
        kind: "team",
        description: "",
        chats: 0,
        members: [caelea],
      };
      projectAgents.value = [];
      expect(render(<Members params={{ id: "p1" }} />)).not.toContain("Manage");
      me.value = { ...caelea, role: "admin" };
      const html = render(<Members params={{ id: "p1" }} />);
      expect(html).toContain('href="/admin/projects?open=p1">Manage<');
      expect(html).toContain('href="/admin/agents">Manage<');
    },
  );

  test("Members renders the users and the agents of the project", () => {
    project.value = {
      ...personal,
      kind: "team",
      description: "",
      chats: 0,
      members: [caelea],
    };
    projectAgents.value = null;
    let html = render(<Members params={{ id: "p1" }} />);
    expect(html).toContain(
      'class="tabs-tab tabs-tab-on" href="/projects/p1/members"',
    );
    expect(html).toContain('class="rows-avatar">OM<');
    expect(html).toContain('class="rows-sub">@caelea<');
    expect(html).toContain('class="rows-line rows-go" href="/users/caelea"');
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
        skills: [],
        createdAt: 0,
      } as never,
    ];
    html = render(<Members params={{ id: "p1" }} />);
    expect(html).toContain('class="rows-name rows-name-mono">coder<');
    expect(html).toContain("deepseek/deepseek-v4-flash");
    // no provider name for a member, and no form to open
    expect(html).toContain(
      'class="rows-meta">128k · $0.14 / $0.28 · tools · reasoning<',
    );
    expect(html).not.toContain("rows-toggle");
    expect(html).toContain('class="rows-line rows-go" href="/agents/coder"');
    projectAgents.value = [];
    expect(render(<Members params={{ id: "p1" }} />)).toContain(
      "No agents yet",
    );
  });

  test("Project heads with the name from the list while loading", () => {
    projects.value = [
      { id: "p9", kind: "team", name: "ops", createdAt: 0, memberCount: 1 },
    ];
    const html = render(<Project params={{ id: "p9" }} />);
    expect(html).toContain('class="page-crumb-on">ops<');
    expect(html).toContain("Loading");
  });
});
