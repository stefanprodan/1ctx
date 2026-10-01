// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A repository is a project's row: admins write a team project's on any
// https host, an owner their personal project's on github.com or
// gitlab.com without a credential. Names are unique in a project, ten to
// a project. A credential must be the project's, cover the repository's
// API and allow GET, and cannot be deleted while a repository names it.
// Deleting a repository forgets its switch in its project.

import { expect, test } from "bun:test";
import type { CredentialResponse } from "../../src/shared/api/credentials.ts";
import type {
  RepoResponse,
  ReposResponse,
  RepoView,
} from "../../src/shared/api/repos.ts";
import type { ProjectAgentsResponse } from "../../src/shared/api/sessions.ts";
import { repoKey } from "../../src/shared/capabilities.ts";
import { MAX_REPOS_PER_PROJECT } from "../../src/shared/contracts/repo.ts";
import type { TestClient } from "../helpers/app.ts";
import { createAutomation } from "../helpers/automations.ts";
import { type ChatApp, chatApp } from "../helpers/chat.ts";
import { createTeam } from "../helpers/projects.ts";

const KEY = "0123456789abcdef-key";
const WIDGETS = "https://github.com/acme/widgets";

async function setup(): Promise<ChatApp & { teamId: string }> {
  const chat = await chatApp({ secrets: { "http-github": KEY } });
  chat.app.automationScheduler.stop();
  const team = await createTeam(chat.admin, "platform", [chat.memberId]);
  return { ...chat, teamId: team.id };
}

async function closed(chat: ChatApp) {
  await chat.app.shutdown();
  chat.app.db.close();
}

async function made(
  client: TestClient,
  path: string,
  body: Record<string, unknown>,
): Promise<RepoView> {
  const res = await client.call("POST", path, { body });
  if (res.status !== 201) {
    throw new Error(`repo create answered ${res.status}: ${await res.text()}`);
  }
  return ((await res.json()) as RepoResponse).repo;
}

async function error(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

test("an admin writes a team project's repositories and its members read them", async () => {
  const chat = await setup();
  try {
    const base = `/api/projects/${chat.teamId}/repos`;
    const repo = await made(chat.admin, base, { url: `${WIDGETS}.git` });
    expect(repo).toMatchObject({
      name: "widgets",
      url: WIDGETS,
      kind: "github",
      ref: "",
      credentialId: null,
      ignore: "",
      state: "pending",
      error: null,
      commit: null,
      fetchedAt: null,
      files: null,
      bytes: null,
      ignored: null,
    });
    await made(chat.admin, base, {
      url: "https://git.example.test/acme/charts",
      kind: "gitlab",
      ref: "v1.2.0",
    });
    const listed = await chat.member.call("GET", base);
    expect(listed.status).toBe(200);
    const { repos } = (await listed.json()) as ReposResponse;
    expect(repos.map((row) => [row.name, row.kind])).toEqual([
      ["charts", "gitlab"],
      ["widgets", "github"],
    ]);
    expect(
      (await chat.member.call("POST", base, { body: { url: WIDGETS } })).status,
    ).toBe(403);
    // a row a fetch left failed: a rename keeps it, a new ref refetches
    chat.app.repos.store.setFetched(repo.id, {
      state: "failed",
      error: "not found",
    });
    const renamed = await chat.admin.call("PATCH", `${base}/${repo.id}`, {
      body: { name: "gadgets" },
    });
    expect(((await renamed.json()) as RepoResponse).repo).toMatchObject({
      name: "gadgets",
      state: "failed",
      error: "not found",
    });
    const moved = await chat.admin.call("PATCH", `${base}/${repo.id}`, {
      body: { ref: "main" },
    });
    expect(((await moved.json()) as RepoResponse).repo).toMatchObject({
      ref: "main",
      state: "pending",
      error: null,
    });
    chat.app.repos.store.setFetched(repo.id, {
      state: "failed",
      error: "host unreachable",
    });
    const refreshed = await chat.admin.call(
      "POST",
      `${base}/${repo.id}/refresh`,
    );
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as RepoResponse).repo.state).toBe(
      "pending",
    );
    expect(
      (
        await chat.admin.call("PATCH", `${base}/${repo.id}`, {
          body: { kind: "gitlab" },
        })
      ).status,
    ).toBe(400);
    expect((await chat.admin.call("DELETE", `${base}/${repo.id}`)).status).toBe(
      204,
    );
    expect((await chat.admin.call("DELETE", `${base}/${repo.id}`)).status).toBe(
      404,
    );
  } finally {
    await closed(chat);
  }
});

test("a personal project's repositories are its owner's, public and on a public host", async () => {
  const chat = await setup();
  try {
    const mine = "/api/profile/project/repos";
    const repo = await made(chat.member, mine, {
      url: "https://gitlab.com/acme/tools/cli",
      ignore: "/*\n!/docs/\n",
    });
    expect(repo).toMatchObject({ name: "cli", kind: "gitlab" });
    const refused = [
      [
        { url: "https://git.example.test/acme/widgets", kind: "github" },
        "github.com or gitlab.com",
      ],
      [{ url: WIDGETS, credentialId: "c1" }, "takes no credential"],
      [{ url: "http://github.com/acme/widgets" }, "https"],
    ] as const;
    for (const [body, words] of refused) {
      const res = await chat.member.call("POST", mine, { body });
      expect(res.status).toBe(400);
      expect(await error(res)).toContain(words);
    }
    // the team routes never reach a personal project, an admin's included
    const adminPersonal = chat.app.projects.personal(chat.adminId)!.id;
    for (const id of [chat.projectId, adminPersonal]) {
      const res = await chat.admin.call("POST", `/api/projects/${id}/repos`, {
        body: { url: WIDGETS },
      });
      expect(res.status).toBe(404);
    }
    const own = await chat.member.call(
      "GET",
      `/api/projects/${chat.projectId}/repos`,
    );
    expect(((await own.json()) as ReposResponse).repos).toHaveLength(1);
    expect(
      (await chat.admin.call("GET", `/api/projects/${chat.projectId}/repos`))
        .status,
    ).toBe(404);
    // a team project's row is not the profile route's
    const teamRepo = await made(
      chat.admin,
      `/api/projects/${chat.teamId}/repos`,
      { url: WIDGETS },
    );
    expect(
      (
        await chat.member.call("PATCH", `${mine}/${teamRepo.id}`, {
          body: { ref: "main" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await chat.member.call("DELETE", `${mine}/${teamRepo.id}`)).status,
    ).toBe(404);
    const patched = await chat.member.call("PATCH", `${mine}/${repo.id}`, {
      body: { ref: "main" },
    });
    expect(((await patched.json()) as RepoResponse).repo.ref).toBe("main");
    expect(
      (await chat.member.call("POST", `${mine}/${repo.id}/refresh`)).status,
    ).toBe(200);
    expect(
      (await chat.member.call("DELETE", `${mine}/${repo.id}`)).status,
    ).toBe(204);
  } finally {
    await closed(chat);
  }
});

test("a name is taken once in a project, and a project holds at most ten", async () => {
  const chat = await setup();
  try {
    const base = `/api/projects/${chat.teamId}/repos`;
    await made(chat.admin, base, { url: WIDGETS });
    const twice = await chat.admin.call("POST", base, {
      body: { url: "https://github.com/other/widgets" },
    });
    expect(twice.status).toBe(409);
    expect(await error(twice)).toBe("a repository named widgets exists");
    // the same name in another project is another folder
    await made(chat.member, "/api/profile/project/repos", { url: WIDGETS });
    for (let i = 1; i < MAX_REPOS_PER_PROJECT; i++) {
      await made(chat.admin, base, {
        url: `https://github.com/acme/repo-${i}`,
      });
    }
    const over = await chat.admin.call("POST", base, {
      body: { url: "https://github.com/acme/one-more" },
    });
    expect(over.status).toBe(409);
    expect(await error(over)).toBe("a project holds at most 10 repositories");
    const { repos } = (await (
      await chat.admin.call("GET", base)
    ).json()) as ReposResponse;
    expect(repos).toHaveLength(MAX_REPOS_PER_PROJECT);
    const rename = await chat.admin.call("PATCH", `${base}/${repos[0]!.id}`, {
      body: { name: "widgets" },
    });
    expect(rename.status).toBe(409);
  } finally {
    await closed(chat);
  }
});

async function credential(
  chat: ChatApp & { teamId: string },
  fields: Record<string, unknown>,
): Promise<string> {
  const res = await chat.admin.call("POST", "/api/credentials", {
    body: {
      name: "github",
      keyName: "http-github",
      prefix: "https://api.github.com/repos/acme/",
      header: "Authorization",
      template: "Bearer {key}",
      projectIds: [chat.teamId],
      ...fields,
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as CredentialResponse).credential.id;
}

test("a credential is the project's, covers the API, allows GET and is kept while named", async () => {
  const chat = await setup();
  try {
    const base = `/api/projects/${chat.teamId}/repos`;
    const id = await credential(chat, {});
    const repo = await made(chat.admin, base, {
      url: WIDGETS,
      credentialId: id,
    });
    expect(repo.credentialId).toBe(id);
    expect(chat.app.repos.auth(chat.app.repos.byId(repo.id)!)).toEqual({
      ok: true,
      header: {
        name: "Authorization",
        value: `Bearer ${KEY}`,
        prefix: "https://api.github.com/repos/acme/",
      },
    });
    const elsewhere = await chat.admin.call("POST", base, {
      body: {
        url: "https://github.com/other/widgets",
        name: "other",
        credentialId: id,
      },
    });
    expect(elsewhere.status).toBe(400);
    expect(await error(elsewhere)).toBe(
      "credential github does not cover https://api.github.com/repos/other/widgets/",
    );
    const missing = await chat.admin.call("POST", base, {
      body: { url: WIDGETS, name: "w2", credentialId: "nosuchid" },
    });
    expect(await error(missing)).toBe("no such credential");
    const gone = await chat.admin.call("DELETE", `/api/credentials/${id}`);
    expect(gone.status).toBe(409);
    expect(await error(gone)).toBe("used by repository platform/widgets");
    // unbinding is allowed, and the next lookup has no access
    const unbound = await chat.admin.call("PATCH", `/api/credentials/${id}`, {
      body: { projectIds: [] },
    });
    expect(unbound.status).toBe(200);
    expect(chat.app.repos.auth(chat.app.repos.byId(repo.id)!)).toEqual({
      ok: false,
      error: "no access",
    });
    const save = await chat.admin.call("PATCH", `${base}/${repo.id}`, {
      body: { ref: "main" },
    });
    expect(await error(save)).toBe(
      "credential github is not bound to this project",
    );
    await chat.admin.call("PATCH", `/api/credentials/${id}`, {
      body: { projectIds: [chat.teamId], methods: ["HEAD"] },
    });
    const head = await chat.admin.call("PATCH", `${base}/${repo.id}`, {
      body: { ref: "main" },
    });
    expect(await error(head)).toBe("credential github does not allow GET");
    const off = await chat.admin.call("PATCH", `${base}/${repo.id}`, {
      body: { credentialId: null },
    });
    expect(off.status).toBe(200);
    expect(
      (await chat.admin.call("DELETE", `/api/credentials/${id}`)).status,
    ).toBe(204);
  } finally {
    await closed(chat);
  }
});

test("deleting a repository forgets its key in its project's chats and tasks", async () => {
  const chat = await setup();
  try {
    const repo = await made(chat.member, "/api/profile/project/repos", {
      url: WIDGETS,
    });
    const key = repoKey(repo.id);
    const kept = repoKey("otherid");
    const sets = [[key, kept, "web"].sort(), [key], ["web"]];
    const chats = sets.map((disabledCapabilities) =>
      chat.app.sessions.create({
        projectId: chat.projectId,
        ownerId: chat.memberId,
        agentId: chat.agentId,
        title: "Stored chat",
        now: chat.app.now.value,
        status: "done",
        disabledCapabilities,
      }),
    );
    // another project's set is never read, a stale key there included
    const elsewhere = chat.app.sessions.create({
      projectId: chat.teamId,
      ownerId: chat.memberId,
      agentId: chat.agentId,
      title: "Team chat",
      now: chat.app.now.value,
      status: "done",
      disabledCapabilities: [key],
    });
    const tasks = await Promise.all(
      sets.map((disabledCapabilities, i) =>
        createAutomation(chat, { name: `task-${i}`, disabledCapabilities }),
      ),
    );
    expect(tasks[0]!.disabledCapabilities).toEqual(sets[0]!);
    const gone = await chat.member.call(
      "DELETE",
      `/api/profile/project/repos/${repo.id}`,
    );
    expect(gone.status).toBe(204);
    const without = (set: string[]) => set.filter((item) => item !== key);
    for (const row of chats) {
      expect(chat.app.sessions.byId(row.id)).toEqual({
        ...row,
        disabledCapabilities: without(row.disabledCapabilities),
      });
    }
    for (const row of tasks) {
      expect(chat.app.automations.byId(row.id)).toEqual({
        ...row,
        disabledCapabilities: without(row.disabledCapabilities),
      });
    }
    expect(chat.app.sessions.byId(elsewhere.id)?.disabledCapabilities).toEqual([
      key,
    ]);
  } finally {
    await closed(chat);
  }
});

test("the composer lists a project's repositories in name order, alike for every caller", async () => {
  const chat = await setup();
  try {
    const base = `/api/projects/${chat.teamId}/repos`;
    const widgets = await made(chat.admin, base, { url: WIDGETS, ref: "main" });
    const charts = await made(chat.admin, base, {
      url: "https://github.com/acme/charts",
    });
    const agents = async (client: TestClient, projectId: string) =>
      (
        (await (
          await client.call("GET", `/api/projects/${projectId}/agents`)
        ).json()) as ProjectAgentsResponse
      ).repos;
    const expected = [
      { id: charts.id, name: "charts", ref: "" },
      { id: widgets.id, name: "widgets", ref: "main" },
    ];
    expect(await agents(chat.member, chat.teamId)).toEqual(expected);
    expect(await agents(chat.admin, chat.teamId)).toEqual(expected);
    expect(await agents(chat.member, chat.projectId)).toEqual([]);
  } finally {
    await closed(chat);
  }
});

test("a turn's first message keeps the commits it mounted", async () => {
  const chat = await setup();
  try {
    const store = chat.app.sessions;
    const session = store.create({
      projectId: chat.projectId,
      ownerId: chat.memberId,
      agentId: chat.agentId,
      title: "Stored chat",
      now: chat.app.now.value,
      status: "done",
    });
    const send = store.createSend({
      sessionId: session.id,
      userId: chat.memberId,
      agentId: chat.agentId,
      providerId: chat.providerId,
      model: "model",
      firstMessageId: "first",
      now: chat.app.now.value,
    });
    store.addUserMessage({
      id: "first",
      sessionId: session.id,
      sendId: send.id,
      userId: chat.memberId,
      content: "read the repository",
      now: chat.app.now.value,
    });
    expect(store.mountedRepos("first")).toBeNull();
    const mounted = { r1: "a".repeat(40), r2: "b".repeat(64) };
    store.setMountedRepos("first", mounted);
    expect(store.mountedRepos("first")).toEqual(mounted);
    expect(store.mountedRepos("missing")).toBeNull();
  } finally {
    await closed(chat);
  }
});
