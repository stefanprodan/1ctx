// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The admin project words, entity, page, and the socket frames that
// keep an open tab's project rail current.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { query } from "../../../src/client/app/router.ts";
import {
  addProjectMember,
  adminProject,
  adminProjectError,
  adminProjects,
  adminProjectsError,
  createProject,
  deleteProject,
  loadAdminProject,
  loadAdminProjects,
  loadProjectUsage,
  projectUsage,
  removeProjectMember,
  setProjectMembers,
  updateProject,
} from "../../../src/client/data/admin-projects.ts";
import { me } from "../../../src/client/data/me.ts";
import { projects } from "../../../src/client/data/projects.ts";
import { startSocket, type Wire } from "../../../src/client/data/socket.ts";
import { users, usersError } from "../../../src/client/data/users.ts";
import { nameProblem } from "../../../src/client/lib/names.ts";
import { Save } from "../../../src/client/lib/save.ts";
import {
  countLine,
  deleteLine,
  descriptionProblem,
  memberOptions,
  nameTaken,
} from "../../../src/client/views/admin/AdminProjects.model.ts";
import { AdminProjects } from "../../../src/client/views/admin/AdminProjects.tsx";
import { ProjectPage } from "../../../src/client/views/admin/ProjectPage.tsx";
import type { AdminUser } from "../../../src/shared/api/users.ts";
import type {
  ProjectDetail,
  ProjectSummary,
} from "../../../src/shared/contracts/project.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const admin: Me = {
  id: "u1",
  username: "admin",
  fullName: "Stefan Prodan",
  role: "admin",
  mustChangePassword: false,
};
const root: AdminUser = {
  ...admin,
  email: "admin@1ctx.dev",
  tz: "UTC",
  createdAt: new Date(2026, 8, 12).getTime(),
  disabled: false,
  lastVisitDay: null,
  projectIds: [],
};
const casey: AdminUser = {
  id: "u2",
  username: "casey",
  fullName: "Casey Doe",
  role: "member",
  email: "casey@example.com",
  tz: "Europe/Bucharest",
  createdAt: new Date(2026, 8, 13).getTime(),
  disabled: false,
  mustChangePassword: false,
  lastVisitDay: null,
  projectIds: [],
};
const personal: ProjectSummary = {
  id: "p1",
  kind: "personal",
  name: "personal",
  createdAt: 0,
  memberCount: 1,
};
const team: ProjectSummary = {
  id: "p2",
  kind: "team",
  name: "platform",
  createdAt: new Date(2026, 8, 14).getTime(),
  memberCount: 1,
};
const detail: ProjectDetail = {
  ...team,
  description: "",
  members: [casey],
  chats: 3,
  knowledge: { files: 0, tokens: 0 },
  latestFiles: [],
};

const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
let stopSocket: (() => void) | null = null;

beforeEach(() => {
  me.value = admin;
  adminProjects.value = null;
  adminProjectsError.value = null;
  adminProject.value = null;
  adminProjectError.value = null;
  projectUsage.value = {};
  projects.value = null;
  users.value = [root, casey];
  usersError.value = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    answer(url, init)) as unknown as typeof fetch;
});

afterEach(() => {
  stopSocket?.();
  stopSocket = null;
  me.value = undefined;
  globalThis.fetch = realFetch;
});

const rail = (rows: ProjectSummary[]) => Response.json({ projects: rows });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the words", () => {
  test("writes the member count and what a delete takes", () => {
    expect(countLine(detail)).toBe("1 member");
    expect(deleteLine(detail)).toBe(
      "Deletes its 3 chats, scheduled tasks and memory. This cannot be undone.",
    );
    expect(deleteLine({ chats: 1, knowledge: { files: 2, tokens: 9 } })).toBe(
      "Deletes its 1 chat, 2 knowledge files, scheduled tasks and memory. This cannot be undone.",
    );
    expect(deleteLine({ chats: 0, knowledge: { files: 0, tokens: 0 } })).toBe(
      "Deletes its scheduled tasks and memory. This cannot be undone.",
    );
  });

  test("a name is taken by another team project or the reserved one", () => {
    expect(nameTaken([team], "platform")).toBe(true);
    expect(nameTaken([team], "platform", "p2")).toBe(false);
    expect(nameTaken([team], "personal")).toBe(true);
    expect(nameTaken([team], "ops")).toBe(false);
  });

  test("New project asks for a description", () => {
    expect(descriptionProblem("  ")).toBe("Describe the project");
    expect(descriptionProblem("Incidents")).toBeNull();
  });

  test("Add member offers the users not drafted in, by full name", () => {
    const mira: AdminUser = {
      ...casey,
      id: "u3",
      username: "mira",
      fullName: "Mira Pop",
      email: "mira@corp.dev",
      disabled: true,
    };
    const offered = memberOptions([mira, root, casey], ["u2"]);
    expect(offered.map((o) => o.label)).toEqual(["Mira Pop", "Stefan Prodan"]);
    expect(offered[0].sub).toBe("@mira · disabled");
    expect(offered[1].sub).toBe("@admin");
    expect(offered[0].keywords).toContain("corp.dev");
  });
});

describe("the entity", () => {
  test.serial(
    "loads only team projects and loads one detail when opened",
    async () => {
      answer = (url) =>
        url === "/api/projects"
          ? rail([personal, team])
          : Response.json({ project: detail });

      await loadAdminProjects();
      expect(adminProjects.value).toEqual([team]);
      expect(adminProject.value).toBeNull();

      await loadAdminProject("p2");
      expect(adminProject.value).toEqual(detail);
    },
  );

  test.serial(
    "create puts the detail in place and reloads the rail",
    async () => {
      let sent: unknown;
      answer = (_url, init) => {
        if (init?.method === "POST") {
          sent = JSON.parse(String(init.body));
          return Response.json({ project: detail }, { status: 201 });
        }
        return rail([personal, team]);
      };

      const body = { name: "platform", description: "Clusters" };
      // a list never loaded is not made of the one row written
      expect(await createProject(body)).toEqual(detail);
      expect(adminProjects.value).toBeNull();
      adminProjects.value = [];
      await createProject(body);
      expect(sent).toEqual(body);
      expect(adminProject.value).toEqual(detail);
      expect(adminProjects.value).toEqual([team]);
      expect(projects.value).toEqual([personal, team]);
    },
  );

  test.serial("a refused name shows the server's words on save", async () => {
    for (const [status, error] of [
      [409, "name is taken"],
      [
        400,
        "name must be 2 to 80 lowercase letters, digits, dashes and underscores",
      ],
    ] as const) {
      answer = () => Response.json({ error }, { status });
      const save = new Save(async () => {
        await createProject({ name: "personal", description: "Mine" });
      });
      await save.run(nameProblem("personal"));
      expect(save.status.value).toEqual({ error, status });
      save.dispose();
    }
    expect(adminProject.value).toBeNull();
  });

  test.serial(
    "update puts the detail in place and reloads the rail",
    async () => {
      const renamed = { ...detail, name: "applications" };
      adminProjects.value = [team];
      answer = (_url, init) =>
        init?.method === "PATCH"
          ? Response.json({ project: renamed })
          : rail([personal, renamed]);

      await updateProject("p2", { name: "applications" });
      expect(adminProject.value).toEqual(renamed);
      expect(adminProjects.value).toEqual([
        {
          id: "p2",
          kind: "team",
          name: "applications",
          createdAt: team.createdAt,
          memberCount: 1,
        },
      ]);
      expect(projects.value).toEqual([personal, renamed]);
    },
  );

  test.serial("add and remove put each answered detail in place", async () => {
    const empty = { ...detail, members: [] };
    let adding = true;
    answer = (_url, init) => {
      if (init?.method === "POST") {
        adding = false;
        return Response.json({ project: detail }, { status: 201 });
      }
      if (init?.method === "DELETE") {
        return Response.json({ project: empty });
      }
      return rail([personal, team]);
    };

    await addProjectMember("p2", { userId: "u2" });
    expect(adding).toBe(false);
    expect(adminProject.value).toEqual(detail);
    expect(projects.value).toEqual([personal, team]);

    await removeProjectMember("p2", "u2");
    expect(adminProject.value).toEqual(empty);
    expect(projects.value).toEqual([personal, team]);
  });

  test.serial("delete removes the row and reloads the rail", async () => {
    adminProjects.value = [team];
    adminProject.value = detail;
    answer = (_url, init) =>
      init?.method === "DELETE"
        ? Response.json({ deleted: 3 })
        : rail([personal]);

    expect(await deleteProject("p2")).toBe(3);
    expect(adminProjects.value).toEqual([]);
    expect(adminProject.value).toBeNull();
    await settle();
    expect(projects.value).toEqual([personal]);
  });

  test.serial("a project already gone is deleted all the same", async () => {
    adminProjects.value = [team];
    adminProject.value = detail;
    answer = (_url, init) =>
      init?.method === "DELETE"
        ? Response.json({ error: "no such project" }, { status: 404 })
        : rail([personal]);
    expect(await deleteProject("p2")).toBe(0);
    expect(adminProjects.value).toEqual([]);
    expect(adminProject.value).toBeNull();
    await settle();
  });

  test.serial(
    "a members save adds then removes, and a refusal rereads the detail",
    async () => {
      const mira = {
        ...casey,
        id: "u3",
        username: "mira",
        fullName: "Mira Pop",
      };
      const calls: string[] = [];
      let rails = 0;
      // another tab took casey out meanwhile
      const reread = { ...detail, members: [mira] };
      answer = (url, init) => {
        if (init?.method === "POST") {
          calls.push(`add ${JSON.parse(String(init.body)).userId}`);
          return Response.json(
            { project: { ...detail, members: [casey, mira] } },
            { status: 201 },
          );
        }
        if (init?.method === "DELETE") {
          calls.push(`remove ${url.split("/").pop()}`);
          return Response.json(
            { error: "userId does not name a user" },
            { status: 404 },
          );
        }
        if (url === "/api/projects/p2") {
          return Response.json({ project: reread });
        }
        rails++;
        return rail([personal, team]);
      };
      await expect(setProjectMembers(detail, ["u3"])).rejects.toThrow(
        "userId does not name a user",
      );
      expect(calls).toEqual(["add u3", "remove u2"]);
      // the draft now matches what is saved, so the card is clean
      expect(adminProject.value?.members.map((m) => m.id)).toEqual(["u3"]);
      expect(rails).toBe(1);
    },
  );

  test.serial(
    "a membership already as asked is done, and the detail is reread",
    async () => {
      const mira = {
        ...casey,
        id: "u3",
        username: "mira",
        fullName: "Mira Pop",
      };
      const reread = { ...detail, members: [mira] };
      answer = (url, init) => {
        if (init?.method === "POST") {
          return Response.json(
            { error: "userId is already a member" },
            { status: 409 },
          );
        }
        if (init?.method === "DELETE") {
          return Response.json(
            { error: "userId is not a member" },
            { status: 409 },
          );
        }
        if (url === "/api/projects/p2")
          return Response.json({ project: reread });
        return rail([personal, team]);
      };
      await setProjectMembers(detail, ["u3"]);
      expect(adminProject.value).toEqual(reread);
    },
  );

  test.serial("the users list follows a project's members", async () => {
    users.value = [
      { ...root, projectIds: [] },
      { ...casey, projectIds: ["p2"] },
    ];
    adminProjects.value = [team];
    answer = (url, init) => {
      if (init?.method === "POST") {
        return Response.json(
          { project: { ...detail, members: [casey, root] } },
          { status: 201 },
        );
      }
      if (init?.method === "DELETE" && url === "/api/projects/p2") {
        return Response.json({ deleted: 0 });
      }
      return rail([personal, team]);
    };
    await setProjectMembers(detail, ["u2", "u1"]);
    expect(users.value?.map((u) => u.projectIds)).toEqual([["p2"], ["p2"]]);
    await deleteProject("p2");
    expect(users.value?.map((u) => u.projectIds)).toEqual([[], []]);
    await settle();
  });

  test.serial(
    "a detail read that finds the project gone drops it",
    async () => {
      adminProjects.value = [team];
      adminProject.value = detail;
      answer = () =>
        Response.json({ error: "no such project" }, { status: 404 });
      await loadAdminProject("p2");
      expect(adminProject.value).toBeNull();
      expect(adminProjects.value).toEqual([]);
    },
  );

  test.serial(
    "a project seen before draws at once while it reloads",
    async () => {
      const other = { ...detail, id: "p3", name: "other" };
      let answerOther!: () => void;
      answer = (url) =>
        url === "/api/projects/p3"
          ? new Promise<Response>((resolve) => {
              answerOther = () => resolve(Response.json({ project: other }));
            })
          : Response.json({ project: detail });
      await loadAdminProject("p2");
      const first = loadAdminProject("p3");
      expect(adminProject.value).toBeNull();
      answerOther();
      await first;
      answer = () => new Promise<Response>(() => {});
      void loadAdminProject("p2");
      expect(adminProject.value).toEqual(detail);
    },
  );

  test.serial(
    "a project's usage lands under its id, a failure as null",
    async () => {
      const body = { since: 0, until: 1, sends: 2, tokens: 30, cost: 0.1 };
      answer = (url) =>
        url === "/api/projects/p2/usage"
          ? Response.json(body)
          : Response.json({ error: "no such project" }, { status: 404 });
      await loadProjectUsage("p2");
      await loadProjectUsage("p9");
      expect(projectUsage.value).toEqual({ p2: body, p9: null });
    },
  );

  test.serial(
    "a previous user's write does not cancel the current loads",
    async () => {
      let answerRename!: () => void;
      let answerList!: () => void;
      let answerDetail!: () => void;
      const current = { ...detail, id: "p3", name: "current" };
      answer = (url, init) =>
        new Promise<Response>((resolve) => {
          if (init?.method === "PATCH") {
            answerRename = () => resolve(Response.json({ project: detail }));
          } else if (url === "/api/projects") {
            answerList = () =>
              resolve(
                rail([
                  personal,
                  {
                    id: "p3",
                    kind: "team",
                    name: "current",
                    createdAt: 0,
                    memberCount: 1,
                  },
                ]),
              );
          } else {
            answerDetail = () => resolve(Response.json({ project: current }));
          }
        });

      const stale = updateProject("p2", { name: "platform" });
      me.value = { ...admin, id: "u3", username: "next" };
      const list = loadAdminProjects();
      const one = loadAdminProject("p3");
      answerRename();
      await stale;
      answerList();
      answerDetail();
      await Promise.all([list, one]);
      expect(adminProjects.value).toEqual([
        {
          id: "p3",
          kind: "team",
          name: "current",
          createdAt: 0,
          memberCount: 1,
        },
      ]);
      expect(adminProject.value).toEqual(current);
    },
  );
});

describe("the page", () => {
  test("the list links each team project to its page and counts both kinds", () => {
    adminProjects.value = [{ ...team, memberCount: 3 }];
    const html = render(<AdminProjects />);
    expect(html).toContain('href="/admin/access/projects?new"');
    expect(html).toContain('href="/admin/access/projects/p2"');
    expect(html).toContain(
      'class="rows-name rows-name-mono"><span class="cut">platform<',
    );
    expect(html).toContain('class="rows-sub">3 members<');
    expect(html).toContain(">since 14 September 2026<");
    expect(html).toContain(">Team<");
    expect(html).toContain(">Personal<");
    expect(html).not.toContain("Casey Doe");
  });

  test("?new is the New project form", () => {
    adminProjects.value = [team];
    query.value = "?new";
    const html = render(<AdminProjects />);
    query.value = "";
    expect(html).toContain('class="admin-projects-page"');
    expect(html).toContain(">Create project<");
    expect(html).toContain('href="/admin/access/projects"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="description"');
    expect(html).toContain('aria-required="true" rows="3"');
  });

  test("a project's page has its cards and its aside", () => {
    adminProjects.value = [team];
    adminProject.value = { ...detail, description: "Incidents and pages" };
    projectUsage.value = {
      p2: { since: 0, until: 1, sends: 4, tokens: 1200, cost: null },
    };
    const html = render(<ProjectPage params={{ id: "p2" }} />);
    expect(html).toContain('value="platform"');
    expect(html).toContain(">Incidents and pages</textarea>");
    expect(html).toContain('aria-required="true" rows="3"');
    expect(html).toContain("Casey Doe");
    expect(html).toContain('aria-label="Remove @casey"');
    expect(html).toContain("Add member");
    expect(html).toContain(">Delete platform<");
    expect(html).toContain("Deletes its 3 chats");
    expect(html).toContain(">not priced<");
  });

  test("a detail that failed shows while the list still loads", () => {
    adminProjectError.value = {
      words: "the server did not answer",
      status: 500,
    };
    const html = render(<ProjectPage params={{ id: "p2" }} />);
    expect(html).toContain("This page did not load");
  });

  test("an id no team project has says so", () => {
    adminProjects.value = [team];
    const html = render(<ProjectPage params={{ id: "p9" }} />);
    expect(html).toContain("No team project by that id.");
  });
});

describe("the rail", () => {
  test.serial(
    "granted and revoked refresh the rail and admin list",
    async () => {
      class FakeWire implements Wire {
        readyState = 1;
        onopen: ((event: unknown) => void) | null = null;
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onclose: ((event: { code: number }) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        send(): void {}
        close(): void {
          this.readyState = 3;
        }
        message(value: unknown): void {
          this.onmessage?.({ data: JSON.stringify(value) });
        }
      }

      const wire = new FakeWire();
      stopSocket = startSocket({ connect: () => wire });
      projects.value = [personal];
      adminProjects.value = [];
      answer = () => rail([personal, team]);

      wire.message({ type: "granted", projectId: "p2" });
      await settle();
      expect(projects.value).toEqual([personal, team]);
      expect(adminProjects.value).toEqual([team]);

      adminProject.value = detail;
      answer = () => rail([personal]);
      wire.message({ type: "revoked", projectId: "p2" });
      await settle();
      expect(projects.value).toEqual([personal]);
      expect(adminProjects.value).toEqual([]);
      expect(adminProject.value).toBeNull();
    },
  );
});
