// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's metadata, its description and its labels, is written by
// every user who sees the project and by no one else; every project
// starts with the four labels.

import { describe, expect, test } from "bun:test";
import type { ProjectDetail } from "../../src/shared/contracts/project.ts";
import {
  collectLogs,
  hashPassword,
  type TestClient,
  testApp,
} from "../helpers/app.ts";
import { createTeam } from "../helpers/projects.ts";

type App = Awaited<ReturnType<typeof testApp>>;

const FOUR = ["build", "fix", "plan", "research"];

async function signedIn(
  app: App,
  username: string,
  role: "admin" | "member" = "member",
) {
  const user = app.createUser({
    username,
    fullName: username.toUpperCase(),
    email: `${username}@example.com`,
    role,
    passwordHash: await hashPassword("pw"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const client = app.client();
  expect((await client.login(username, "pw")).status).toBe(200);
  return { user, client };
}

async function setup(options: Parameters<typeof testApp>[0] = {}) {
  const app = await testApp(options);
  const admin = app.client();
  expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
  const casey = await signedIn(app, "casey");
  const robin = await signedIn(app, "robin");
  const team = await createTeam(admin, "platform", [casey.user.id]);
  return { app, admin, casey, robin, team };
}

const names = (project: ProjectDetail) => project.labels.map((l) => l.name);

async function detail(res: Response): Promise<ProjectDetail> {
  return ((await res.json()) as { project: ProjectDetail }).project;
}

const labelsPath = (project: { id: string }) =>
  `/api/projects/${project.id}/labels`;

describe("a project's labels at creation", () => {
  test("a team project and a personal one start with the four, by name", async () => {
    const { app, casey, team } = await setup();
    expect(names(team)).toEqual(FOUR);
    expect(team.labels.find((l) => l.name === "fix")?.description).toBe(
      "A defect or failure to correct",
    );
    const personal = app.projects.personal(casey.user.id)!;
    const res = await casey.client.call("GET", `/api/projects/${personal.id}`);
    expect(names(await detail(res))).toEqual(FOUR);
  });

  test("a team project created with its own labels gets those", async () => {
    const { admin } = await setup();
    const res = await admin.call("POST", "/api/projects", {
      body: {
        name: "finops",
        description: "Spend",
        labels: [{ name: " Budget " }, { name: "bill", description: "Bills" }],
      },
    });
    expect(res.status).toBe(201);
    const made = await detail(res);
    expect(
      made.labels.map(({ name, description }) => ({ name, description })),
    ).toEqual([
      { name: "bill", description: "Bills" },
      { name: "budget", description: "" },
    ]);
  });

  test("a create refuses labels that break the rules", async () => {
    const { admin } = await setup();
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `l${i}` }));
    for (const labels of [
      [],
      many,
      [{ name: "ops" }, { name: "OPS" }],
      [{ name: "back end" }],
      [{ name: "ops", description: "two\nlines" }],
      [{ name: "ops", colour: "red" }],
      ["ops"],
      "ops",
    ]) {
      const res = await admin.call("POST", "/api/projects", {
        body: { name: "finops", description: "Spend", labels },
      });
      expect(res.status).toBe(400);
    }
    const named = await admin.call("POST", "/api/projects", {
      body: {
        name: "finops",
        description: "Spend",
        labels: [{ name: "ok" }, { name: "-bad" }],
      },
    });
    expect((await named.json()).error).toStartWith("labels.1.name must be");
  });
});

describe("a project's description", () => {
  test("a member, an admin and a personal project's owner write it", async () => {
    const { app, admin, casey, team } = await setup();
    const about = `/api/projects/${team.id}/about`;
    const byMember = await casey.client.call("PATCH", about, {
      body: { description: "Clusters and pages" },
    });
    expect(byMember.status).toBe(200);
    expect((await detail(byMember)).description).toBe("Clusters and pages");
    const byAdmin = await admin.call("PATCH", about, {
      body: { description: "Clusters" },
    });
    expect((await detail(byAdmin)).description).toBe("Clusters");
    const own = app.projects.personal(casey.user.id)!;
    const byOwner = await casey.client.call(
      "PATCH",
      `/api/projects/${own.id}/about`,
      { body: { description: "" } },
    );
    expect(byOwner.status).toBe(200);
  });

  test("a user who cannot see the project gets 404, an admin on another's personal one too", async () => {
    const { app, admin, casey, robin, team } = await setup();
    expect(
      (
        await robin.client.call("PATCH", `/api/projects/${team.id}/about`, {
          body: { description: "Mine now" },
        })
      ).status,
    ).toBe(404);
    const own = app.projects.personal(casey.user.id)!;
    expect(
      (
        await admin.call("PATCH", `/api/projects/${own.id}/about`, {
          body: { description: "Peek" },
        })
      ).status,
    ).toBe(404);
    expect(app.projects.byId(team.id)!.description).toBe("A team project.");
    expect(app.projects.byId(own.id)!.description).toBe("");
  });

  test("a team project's stays required and the name is not written here", async () => {
    const { casey, team } = await setup();
    const about = `/api/projects/${team.id}/about`;
    for (const body of [
      { description: "" },
      {},
      { name: "ops", description: "x" },
      { description: " padded" },
      { description: "x".repeat(281) },
    ]) {
      expect((await casey.client.call("PATCH", about, { body })).status).toBe(
        400,
      );
    }
    expect(
      (
        await casey.client.call("PATCH", `/api/projects/${team.id}`, {
          body: { name: "ops" },
        })
      ).status,
    ).toBe(403);
  });
});

describe("a project's labels", () => {
  test("a member adds, renames, redescribes and deletes one", async () => {
    const { casey, team } = await setup();
    const added = await casey.client.call("POST", labelsPath(team), {
      body: { name: "  Infra ", description: "Clusters" },
    });
    expect(added.status).toBe(201);
    const withInfra = await detail(added);
    expect(names(withInfra)).toEqual([
      "build",
      "fix",
      "infra",
      "plan",
      "research",
    ]);
    const infra = withInfra.labels.find((l) => l.name === "infra")!;
    const renamed = await casey.client.call(
      "PATCH",
      `${labelsPath(team)}/${infra.id}`,
      { body: { name: "ops" } },
    );
    expect(renamed.status).toBe(200);
    expect((await detail(renamed)).labels).toContainEqual({
      id: infra.id,
      name: "ops",
      description: "Clusters",
      tasks: 0,
    });
    const redescribed = await casey.client.call(
      "PATCH",
      `${labelsPath(team)}/${infra.id}`,
      { body: { description: "" } },
    );
    expect((await detail(redescribed)).labels).toContainEqual({
      id: infra.id,
      name: "ops",
      description: "",
      tasks: 0,
    });
    const deleted = await casey.client.call(
      "DELETE",
      `${labelsPath(team)}/${infra.id}`,
    );
    expect(deleted.status).toBe(200);
    expect(names(await detail(deleted))).toEqual(FOUR);
  });

  test("names and descriptions are held to their rules", async () => {
    const { casey, team } = await setup();
    for (const body of [
      { name: "back end" },
      { name: "" },
      { name: "   " },
      { name: "-ops" },
      { name: "ops_1" },
      { name: "é" },
      { name: "x".repeat(25) },
      { name: 7 },
      {},
      { name: "ops", description: "x".repeat(101) },
      { name: "ops", description: " padded" },
      { name: "ops", description: "two\nlines" },
      { name: "ops", colour: "red" },
    ]) {
      const res = await casey.client.call("POST", labelsPath(team), { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const longest = await casey.client.call("POST", labelsPath(team), {
      body: { name: `9${"a".repeat(22)}-`, description: "x".repeat(100) },
    });
    expect(longest.status).toBe(201);
    const fix = team.labels.find((l) => l.name === "fix")!;
    expect(
      (
        await casey.client.call("PATCH", `${labelsPath(team)}/${fix.id}`, {
          body: {},
        })
      ).status,
    ).toBe(400);
  });

  test("a name the project holds is a 409, on create and on rename", async () => {
    const { casey, team } = await setup();
    const taken = await casey.client.call("POST", labelsPath(team), {
      body: { name: "BUILD" },
    });
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toBe("name is taken");
    const fix = team.labels.find((l) => l.name === "fix")!;
    const rename = await casey.client.call(
      "PATCH",
      `${labelsPath(team)}/${fix.id}`,
      { body: { name: "plan" } },
    );
    expect(rename.status).toBe(409);
    // its own name is no clash
    expect(
      (
        await casey.client.call("PATCH", `${labelsPath(team)}/${fix.id}`, {
          body: { name: "fix", description: "Bugs" },
        })
      ).status,
    ).toBe(200);
  });

  test("the 21st label and the last delete are refused", async () => {
    const { app, casey, team } = await setup();
    for (let i = 0; i < 16; i++) {
      const res = await casey.client.call("POST", labelsPath(team), {
        body: { name: `area-${i}` },
      });
      expect(res.status).toBe(201);
    }
    const over = await casey.client.call("POST", labelsPath(team), {
      body: { name: "one-more" },
    });
    expect(over.status).toBe(409);
    expect((await over.json()).error).toBe("a project holds at most 20 labels");
    const own = app.projects.personal(casey.user.id)!;
    const ids = app.projects.labels(own.id).map((l) => l.id);
    for (const id of ids.slice(1)) {
      expect(
        (await casey.client.call("DELETE", `${labelsPath(own)}/${id}`)).status,
      ).toBe(200);
    }
    const last = await casey.client.call(
      "DELETE",
      `${labelsPath(own)}/${ids[0]}`,
    );
    expect(last.status).toBe(409);
    expect((await last.json()).error).toBe(
      "a project keeps at least one label",
    );
    expect(app.projects.labelCount(own.id)).toBe(1);
  });

  test("a label is reached only through its own project", async () => {
    const { app, admin, casey, robin, team } = await setup();
    const own = app.projects.personal(casey.user.id)!;
    const theirs = app.projects.labels(own.id)[0]!;
    // another project's path, which the caller sees, is no way in
    for (const [method, body] of [
      ["PATCH", { name: "mine" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await casey.client.call(
        method,
        `${labelsPath(team)}/${theirs.id}`,
        { body },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("no such label");
    }
    // a project the caller does not see is a 404 whatever the label
    const fix = team.labels.find((l) => l.name === "fix")!;
    const outsiders: [TestClient, string, string][] = [
      [robin.client, labelsPath(team), fix.id],
      [admin, labelsPath(own), theirs.id],
    ];
    for (const [client, path, id] of outsiders) {
      expect(
        (await client.call("POST", path, { body: { name: "spy" } })).status,
      ).toBe(404);
      expect(
        (
          await client.call("PATCH", `${path}/${id}`, {
            body: { name: "spy" },
          })
        ).status,
      ).toBe(404);
      expect((await client.call("DELETE", `${path}/${id}`)).status).toBe(404);
    }
    expect(app.projects.labels(own.id).map((l) => l.name)).toEqual(FOUR);
    expect(app.projects.labels(team.id).map((l) => l.name)).toEqual(FOUR);
  });

  test("labels go with their project", async () => {
    const { app, admin, team } = await setup();
    expect(
      (await admin.call("DELETE", `/api/projects/${team.id}`)).status,
    ).toBe(200);
    expect(app.projects.labels(team.id)).toEqual([]);
  });

  test("no log line holds a label's name or description", async () => {
    const { events, logFactory } = collectLogs();
    const { casey, team } = await setup({ logFactory });
    const added = await casey.client.call("POST", labelsPath(team), {
      body: { name: "zebra-secret", description: "Quokka words" },
    });
    const zebra = (await detail(added)).labels.find(
      (l) => l.name === "zebra-secret",
    )!;
    await casey.client.call("PATCH", `${labelsPath(team)}/${zebra.id}`, {
      body: { name: "plan", description: "Wombat words" },
    });
    await casey.client.call("POST", labelsPath(team), {
      body: { name: "bad name", description: "Koala words" },
    });
    await casey.client.call("DELETE", `${labelsPath(team)}/${zebra.id}`);
    const logged = JSON.stringify(events);
    expect(events.some((e) => e.msg === "request")).toBe(true);
    for (const word of ["zebra", "Quokka", "Wombat", "Koala", "bad name"]) {
      expect(logged).not.toContain(word);
    }
  });
});
