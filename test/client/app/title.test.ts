// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tab's title reads most specific first and the brand last: the
// route's word until the page's row is in, then the object's name and
// its project, and it follows a rename.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { path } from "../../../src/client/app/router.ts";
import { tabTitle } from "../../../src/client/app/Title.model.ts";
import { pageTitle, watchTitle } from "../../../src/client/app/Title.state.ts";
import { adminProject } from "../../../src/client/data/admin-projects.ts";
import {
  automationProject,
  automations,
} from "../../../src/client/data/automations.ts";
import { taskPage } from "../../../src/client/data/external-task.ts";
import { docFiles } from "../../../src/client/data/knowledge-file.ts";
import { me } from "../../../src/client/data/me.ts";
import { projects } from "../../../src/client/data/projects.ts";
import { session } from "../../../src/client/data/sessions.ts";
import { startSocket } from "../../../src/client/data/socket.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";
import { FakeWire } from "../../helpers/client-socket.ts";

const casey: Me = {
  id: "u1",
  username: "casey",
  fullName: "Casey",
  role: "admin",
  mustChangePassword: false,
};

const chat = (id: string, title: string, revision = 1) => ({
  id,
  projectId: "p1",
  origin: "chat",
  automationId: null,
  title,
  revision,
});

beforeEach(() => {
  me.value = casey;
  path.value = "/";
  projects.value = [{ id: "p1", name: "Platform" }] as never;
  session.value = null;
  automations.value = null;
  automationProject.value = null;
  taskPage.value = null;
  docFiles.value = new Map();
  adminProject.value = null;
});

afterEach(() => {
  me.value = null;
  path.value = "/";
});

describe("the title's parts", () => {
  test("most specific first, the brand last, empty parts left out", () => {
    expect(
      tabTitle({ word: "Chat", name: "Fix", project: "Ops", admin: false }),
    ).toBe("Fix · Ops · 1ctx");
    expect(
      tabTitle({ word: "Chat", name: "", project: null, admin: false }),
    ).toBe("Chat · 1ctx");
    expect(
      tabTitle({ word: "Users", name: null, project: null, admin: true }),
    ).toBe("Users · Admin · 1ctx");
    expect(tabTitle(null)).toBe("1ctx");
  });
});

describe("a page's title", () => {
  test.serial("a chat: the word, then its title and project", () => {
    path.value = "/chat/s1";
    expect(pageTitle()).toBe("Chat · 1ctx");
    session.value = { session: chat("s1", "Fix the build") } as never;
    expect(pageTitle()).toBe("Fix the build · Platform · 1ctx");
    // a row left by the page before never names the next
    path.value = "/chat/s2";
    expect(pageTitle()).toBe("Chat · 1ctx");
  });

  test.serial("a session on the other origin's address keeps the word", () => {
    path.value = "/run/s1";
    session.value = { session: chat("s1", "Fix the build") } as never;
    expect(pageTitle()).toBe("Run · 1ctx");
  });

  test.serial("a run is named by its automation", () => {
    automations.value = [
      { id: "a1", projectId: "p1", name: "Weekly" },
    ] as never;
    path.value = "/run/r1";
    expect(pageTitle()).toBe("Run · 1ctx");
    session.value = {
      session: {
        id: "r1",
        projectId: "p1",
        origin: "automation",
        automationId: "a1",
        title: "Digest",
      },
    } as never;
    expect(pageTitle()).toBe("Run of Weekly · Platform · 1ctx");
  });

  test.serial("an automation, its Memory tab and its edit page", () => {
    automations.value = [
      { id: "a1", projectId: "p1", name: "Digest" },
    ] as never;
    path.value = "/automations/a1";
    expect(pageTitle()).toBe("Automation · 1ctx");
    automationProject.value = { id: "a1", projectId: "p1" };
    expect(pageTitle()).toBe("Digest · Platform · 1ctx");
    path.value = "/automations/a1/memory";
    expect(pageTitle()).toBe("Digest · Platform · 1ctx");
    path.value = "/automations/a1/edit";
    expect(pageTitle()).toBe("Digest · Platform · 1ctx");
  });

  test.serial("an external task", () => {
    path.value = "/external-tasks/t1";
    expect(pageTitle()).toBe("External task · 1ctx");
    taskPage.value = {
      id: "t1",
      detail: { task: { id: "t1", projectId: "p1", title: "Rotate keys" } },
    } as never;
    expect(pageTitle()).toBe("Rotate keys · Platform · 1ctx");
  });

  test.serial("a knowledge file is named by its path", () => {
    path.value = "/projects/p1/knowledge/files/f1";
    expect(pageTitle()).toBe("Knowledge · Platform · 1ctx");
    docFiles.value = new Map([
      [
        "f1",
        {
          state: "done",
          file: { id: "f1", projectId: "p1", name: "plans/x.md" },
          newer: null,
          deleted: null,
          failure: null,
        } as never,
      ],
    ]);
    expect(pageTitle()).toBe("plans/x.md · Platform · 1ctx");
  });

  test.serial("a project's tabs: the tab's word, then the project", () => {
    path.value = "/projects/p1";
    expect(pageTitle()).toBe("Feed · Platform · 1ctx");
    path.value = "/projects/p1/automations";
    expect(pageTitle()).toBe("Automations · Platform · 1ctx");
    // before the rail's list is in, the word alone
    projects.value = null;
    expect(pageTitle()).toBe("Automations · 1ctx");
  });

  test.serial("pages outside a project: the word and the brand", () => {
    for (const [at, title] of [
      ["/", "Home · 1ctx"],
      ["/projects", "Projects · 1ctx"],
      ["/directory", "Directory · 1ctx"],
      ["/profile", "Profile · 1ctx"],
      ["/users/robin", "@robin · 1ctx"],
    ]) {
      path.value = at;
      expect(pageTitle()).toBe(title);
    }
  });

  test.serial("admin pages: the word or the object, then Admin", () => {
    path.value = "/admin/access/users";
    expect(pageTitle()).toBe("Users · Admin · 1ctx");
    path.value = "/admin/access/users/robin";
    expect(pageTitle()).toBe("@robin · Admin · 1ctx");
    path.value = "/admin/config/providers/openrouter";
    expect(pageTitle()).toBe("openrouter · Admin · 1ctx");
    // a team project in the rail's list is still the admin's object
    path.value = "/admin/access/projects/p1";
    expect(pageTitle()).toBe("Project · Admin · 1ctx");
    adminProject.value = { id: "p2", name: "Finops" } as never;
    expect(pageTitle()).toBe("Project · Admin · 1ctx");
    adminProject.value = { id: "p1", name: "Platform" } as never;
    expect(pageTitle()).toBe("Platform · Admin · 1ctx");
  });

  test.serial("signed out: Sign in, whatever the address", () => {
    me.value = null;
    path.value = "/chat/s1";
    expect(pageTitle()).toBe("Sign in · 1ctx");
    path.value = "/nothing";
    expect(pageTitle()).toBe("Sign in · 1ctx");
    // a page an email links to needs nobody
    path.value = "/link/abc";
    expect(pageTitle()).toBe("Email link · 1ctx");
  });

  test.serial("an unknown address while signed in is the brand", () => {
    path.value = "/nothing/here";
    expect(pageTitle()).toBe("1ctx");
  });
});

describe("the tab follows its page", () => {
  const g = globalThis as { document?: unknown };
  let held: unknown;
  beforeEach(() => {
    held = g.document;
    g.document = { title: "" };
  });
  afterEach(() => {
    g.document = held;
  });
  const tab = () => (g.document as { title: string }).title;

  test.serial("a row read late and a rename change the tab", () => {
    const wire = new FakeWire();
    const stopSocket = startSocket({ connect: () => wire });
    const stop = watchTitle();
    try {
      path.value = "/chat/s1";
      expect(tab()).toBe("Chat · 1ctx");
      session.value = {
        session: chat("s1", "Fix the build"),
        messages: [],
      } as never;
      expect(tab()).toBe("Fix the build · Platform · 1ctx");
      wire.message(
        JSON.stringify({
          type: "session",
          projectId: "p1",
          session: chat("s1", "Fix the release", 2),
          messages: [],
        }),
      );
      expect(tab()).toBe("Fix the release · Platform · 1ctx");
    } finally {
      stop();
      stopSocket();
    }
  });

  test.serial("an automation renamed in its list renames the tab", () => {
    const stop = watchTitle();
    try {
      automations.value = [
        { id: "a1", projectId: "p1", name: "Digest" },
      ] as never;
      automationProject.value = { id: "a1", projectId: "p1" };
      path.value = "/automations/a1";
      expect(tab()).toBe("Digest · Platform · 1ctx");
      automations.value = [
        { id: "a1", projectId: "p1", name: "Weekly" },
      ] as never;
      expect(tab()).toBe("Weekly · Platform · 1ctx");
      // a renamed project too
      projects.value = [{ id: "p1", name: "Ops" }] as never;
      expect(tab()).toBe("Weekly · Ops · 1ctx");
    } finally {
      stop();
    }
  });
});
