// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The admin project words, entity, page, rail entry, and the socket
// frames that keep an open tab's project rail current.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { query } from "../../../src/client/app/router.ts";
import { railRows } from "../../../src/client/app/routes.ts";
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
  removeProjectMember,
  updateProject,
} from "../../../src/client/data/admin-projects.ts";
import { me } from "../../../src/client/data/me.ts";
import { projects } from "../../../src/client/data/projects.ts";
import { startSocket, type Wire } from "../../../src/client/data/socket.ts";
import { users, usersError } from "../../../src/client/data/users.ts";
import { Save } from "../../../src/client/lib/save.ts";
import {
  candidateNote,
  candidates,
  countLine,
  deleteLabel,
  mark,
  plural,
  sinceLine,
  step,
} from "../../../src/client/views/admin/AdminProjects.model.ts";
import { AdminProjects } from "../../../src/client/views/admin/AdminProjects.tsx";
import { ProjectForm } from "../../../src/client/views/admin/ProjectForm.tsx";
import { nameProblem } from "../../../src/client/views/projects/Project.model.ts";
import type {
  ProjectDetail,
  ProjectSummary,
} from "../../../src/shared/contracts/project.ts";
import type { Me, UserAccount } from "../../../src/shared/contracts/user.ts";

const admin: Me = {
  id: "u1",
  username: "admin",
  fullName: "Stefan Prodan",
  role: "admin",
  mustChangePassword: false,
};
const root: UserAccount = {
  ...admin,
  email: "admin@1ctx.dev",
  createdAt: new Date(2026, 8, 12).getTime(),
  disabled: false,
};
const caelea: UserAccount = {
  id: "u2",
  username: "caelea",
  fullName: "Oana Mangiurea",
  role: "member",
  email: "caelea@example.com",
  createdAt: new Date(2026, 8, 13).getTime(),
  disabled: false,
  mustChangePassword: false,
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
  members: [caelea],
  chats: 3,
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
  projects.value = null;
  users.value = [root, caelea];
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
  test("leaves the name rule to the server and catches an empty name", () => {
    expect(nameProblem("platform")).toBeNull();
    expect(nameProblem(" platform ")).toBeNull();
    expect(nameProblem("a")).toBeNull();
    expect(nameProblem("platform.team")).toBeNull();
    expect(nameProblem("")).toBe("Enter a name");
    expect(nameProblem("  ")).toBe("Enter a name");
  });

  test("writes the member, date, and delete counts", () => {
    expect(plural(1, "member")).toBe("1 member");
    expect(plural(2, "member")).toBe("2 members");
    expect(countLine(detail)).toBe("1 member");
    expect(sinceLine(detail)).toBe("since 14 September 2026");
    expect(deleteLabel(3)).toBe("Delete with 3 chats");
    expect(deleteLabel(1)).toBe("Delete with 1 chat");
    expect(deleteLabel(0)).toBe("Delete");
  });

  test("marks an avatar with the first letters of the name", () => {
    expect(mark("on-call")).toBe("OC");
    expect(mark("research")).toBe("RE");
    expect(mark("a-b-c")).toBe("AB");
  });

  test("offers the people not in the project, by any of their names", () => {
    const mira: UserAccount = {
      ...caelea,
      id: "u3",
      username: "mira",
      fullName: "Mira Pop",
      email: "mira@corp.dev",
      disabled: true,
    };
    const all = [caelea, root, mira];
    const none = new Set<string>();
    expect(candidates(all, none, "").map((u) => u.username)).toEqual([
      "mira",
      "caelea",
      "admin",
    ]);
    expect(candidates(all, new Set(["u2"]), "")).not.toContain(caelea);
    expect(candidates(all, none, "MANG")).toEqual([caelea]);
    expect(candidates(all, none, "@mira")).toEqual([mira]);
    expect(candidates(all, none, "corp.dev")).toEqual([mira]);
    expect(candidates(all, none, " nobody ")).toEqual([]);
    expect(candidateNote(mira)).toBe("disabled");
    expect(candidateNote(root)).toBe("admin");
    expect(candidateNote(caelea)).toBe("");
  });

  test("the arrows wrap at either end of the list", () => {
    expect(step(0, 1, 3)).toBe(1);
    expect(step(2, 1, 3)).toBe(0);
    expect(step(0, -1, 3)).toBe(2);
    expect(step(0, 1, 0)).toBe(0);
  });
});

describe("the entity", () => {
  test("loads only team projects and loads one detail when opened", async () => {
    answer = (url) =>
      url === "/api/projects"
        ? rail([personal, team])
        : Response.json({ project: detail });

    await loadAdminProjects();
    expect(adminProjects.value).toEqual([team]);
    expect(adminProject.value).toBeNull();

    await loadAdminProject("p2");
    expect(adminProject.value).toEqual(detail);
  });

  test("create puts the detail in place and reloads the rail", async () => {
    let sent: unknown;
    answer = (_url, init) => {
      if (init?.method === "POST") {
        sent = JSON.parse(String(init.body));
        return Response.json({ project: detail }, { status: 201 });
      }
      return rail([personal, team]);
    };

    expect(await createProject({ name: "platform" })).toEqual(detail);
    expect(sent).toEqual({ name: "platform" });
    expect(adminProject.value).toEqual(detail);
    expect(adminProjects.value).toEqual([team]);
    expect(projects.value).toEqual([personal, team]);
  });

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
        await createProject({ name: "personal" });
      });
      await save.run(nameProblem("personal"));
      expect(save.status.value).toEqual({ error });
      save.dispose();
    }
    expect(adminProject.value).toBeNull();
  });

  test("update puts the detail in place and reloads the rail", async () => {
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
  });

  test("add and remove put each answered detail in place", async () => {
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

  test("delete removes the row and reloads the rail", async () => {
    adminProjects.value = [team];
    adminProject.value = detail;
    answer = (_url, init) =>
      init?.method === "DELETE"
        ? Response.json({ deleted: 3 })
        : rail([personal]);

    expect(await deleteProject("p2")).toBe(3);
    expect(adminProjects.value).toEqual([]);
    expect(adminProject.value).toBeNull();
    expect(projects.value).toEqual([personal]);
  });

  test("a previous user's write does not cancel the current loads", async () => {
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
      { id: "p3", kind: "team", name: "current", createdAt: 0, memberCount: 1 },
    ]);
    expect(adminProject.value).toEqual(current);
  });
});

describe("the page", () => {
  test("collapsed rows show the name and the counts, never members", () => {
    adminProjects.value = [{ ...team, memberCount: 3 }];
    const html = render(<AdminProjects />);
    expect(html).toContain("New project");
    expect(html).toContain('class="rows-name rows-name-mono">platform<');
    expect(html).toContain(">PL<");
    expect(html).toContain('class="rows-sub">3 members<');
    expect(html).toContain(">since 14 September 2026<");
    expect(html).not.toContain("Oana Mangiurea");
    expect(html).not.toContain(">Members<");
  });

  test("a row named in the query opens", () => {
    adminProjects.value = [team];
    adminProject.value = detail;
    query.value = "?open=p2";
    const html = render(<AdminProjects />);
    query.value = "";
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Oana Mangiurea");
  });

  test("an open row shows the description, members, remove, add, and delete", () => {
    const html = render(
      <ProjectForm
        project={{ ...detail, description: "Incidents and pages" }}
        users={[root, caelea]}
        onDone={() => {}}
      />,
    );
    expect(html).toContain('name="description"');
    expect(html).toContain(">Incidents and pages</textarea>");
    expect(html).toContain("Oana Mangiurea");
    expect(html).toContain("@caelea");
    expect(html).toContain(">Remove<");
    expect(html).toContain("Add member");
    expect(html).not.toContain("Search people");
    expect(html).toContain(">Delete<");
  });
});

describe("the rail", () => {
  test("Projects is first in the Admin group", () => {
    const group = railRows("admin").find((row) => row.kind === "group");
    const entries =
      group?.kind === "group"
        ? group.routes.map((route) => route.nav!.label)
        : [];
    expect(entries).toEqual(["Projects", "Users", "Agents", "Tools", "Skills"]);
  });

  test("granted and revoked refresh the rail and admin list", async () => {
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
  });
});
