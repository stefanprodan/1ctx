// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Recent watcher records a page once the row it shows is read,
// places it once per visit, keeps the order for a page opened from the
// list, keeps one list per user in localStorage; the rail draws it
// between Directory and Projects on the working face only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Rail } from "../../../src/client/app/Rail.tsx";
import {
  automationRecent,
  type RecentRow,
  sessionRecent,
} from "../../../src/client/app/Recent.model.ts";
import {
  pickRecent,
  recent,
  recentStoreKey,
  watchRecent,
} from "../../../src/client/app/Recent.state.ts";
import { path } from "../../../src/client/app/router.ts";
import {
  automationProject,
  automations,
} from "../../../src/client/data/automations.ts";
import { taskPage } from "../../../src/client/data/external-task.ts";
import { docFiles } from "../../../src/client/data/knowledge-file.ts";
import { me } from "../../../src/client/data/me.ts";
import { projects } from "../../../src/client/data/projects.ts";
import { session } from "../../../src/client/data/sessions.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const store = new Map<string, string>();
let full = false;
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (full) throw new Error("QuotaExceededError");
    store.set(k, v);
  },
  removeItem: (k: string) => void store.delete(k),
};

const casey: Me = {
  id: "u1",
  username: "casey",
  fullName: "Casey",
  role: "member",
  mustChangePassword: false,
};
const robin: Me = { ...casey, id: "u2", username: "robin" };

const click = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

const openChat = (id: string, title = `chat ${id}`) => {
  session.value = {
    session: {
      id,
      projectId: "p1",
      origin: "chat",
      automationId: null,
      title,
    },
  } as never;
};
const openRun = (id: string, automationId: string, title = "Digest") => {
  session.value = {
    session: { id, projectId: "p1", origin: "automation", automationId, title },
  } as never;
};
const chatRow = (id: string, title = `chat ${id}`): RecentRow =>
  sessionRecent({
    id,
    projectId: "p1",
    origin: "chat",
    automationId: null,
    title,
  });

// a page opened another way: a link elsewhere on the page or the
// address bar, its row read at once
const visit = (id: string) => {
  path.value = "/";
  path.value = `/chat/${id}`;
  openChat(id);
};

const ids = () => recent.value.map((r) => r.id);
const stored = (userId = "u1") =>
  JSON.parse(store.get(recentStoreKey(userId)) ?? "null");

let stop: () => void = () => {};

beforeEach(() => {
  store.clear();
  full = false;
  (globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
  path.value = "/";
  me.value = casey;
  session.value = null;
  taskPage.value = null;
  docFiles.value = new Map();
  automations.value = null;
  automationProject.value = null;
  stop = watchRecent();
});

afterEach(() => {
  stop();
  me.value = null;
  path.value = "/";
});

describe("recording a page", () => {
  test.serial("a chat records once its row is read", () => {
    path.value = "/chat/s1";
    expect(recent.value).toEqual([]);
    openChat("s1");
    expect(recent.value).toEqual([chatRow("s1")]);
    expect(stored()).toEqual([chatRow("s1")]);
  });

  test.serial("a held row of another chat records nothing", () => {
    openChat("s0");
    path.value = "/chat/s1";
    expect(recent.value).toEqual([]);
  });

  test.serial("a run records as its automation's runs", () => {
    path.value = "/run/r1";
    openRun("r1", "a1");
    path.value = "/";
    path.value = "/run/r2";
    openRun("r2", "a1");
    expect(recent.value).toEqual([
      sessionRecent({
        id: "r2",
        projectId: "p1",
        origin: "automation",
        automationId: "a1",
        title: "Digest",
      }),
    ]);
  });

  test.serial("an automation records once its own read names it", () => {
    const row = { id: "a1", projectId: "p1", name: "Digest" };
    automations.value = [row] as never;
    path.value = "/automations/a1";
    expect(recent.value).toEqual([]);
    automationProject.value = { id: "a1", projectId: "p1" };
    expect(recent.value).toEqual([automationRecent(row)]);
  });

  test.serial("an automation's Memory tab records the automation", () => {
    automations.value = [
      { id: "a1", projectId: "p1", name: "Digest" },
    ] as never;
    automationProject.value = { id: "a1", projectId: "p1" };
    path.value = "/automations/a1/memory";
    expect(recent.value.map((r) => [r.kind, r.id])).toEqual([
      ["automation", "a1"],
    ]);
  });

  test.serial("an external task records once its page is read", () => {
    path.value = "/external-tasks/t1";
    expect(recent.value).toEqual([]);
    taskPage.value = {
      id: "t1",
      detail: { task: { id: "t1", projectId: "p1", title: "Fix it" } },
    } as never;
    expect(recent.value.map((r) => [r.kind, r.title])).toEqual([
      ["task", "Fix it"],
    ]);
  });

  test.serial("a knowledge file records once its text is read", () => {
    path.value = "/projects/p1/knowledge/files/f1";
    docFiles.value = new Map([["f1", { state: "loading" }]]);
    expect(recent.value).toEqual([]);
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
    expect(recent.value.map((r) => [r.kind, r.title])).toEqual([
      ["file", "plans/x.md"],
    ]);
  });

  test.serial("an edit page, a list and an admin page never record", () => {
    automations.value = [
      { id: "a1", projectId: "p1", name: "Digest" },
    ] as never;
    automationProject.value = { id: "a1", projectId: "p1" };
    openChat("s1");
    for (const pathname of [
      "/automations/a1/edit",
      "/projects/p1/automations",
      "/projects/p1",
      "/admin/monitor",
      "/admin/access/users/casey",
    ]) {
      path.value = pathname;
    }
    expect(recent.value).toEqual([]);
    expect(store.size).toBe(0);
  });
});

describe("placing a page once per visit", () => {
  test.serial("a page opened another way moves to the top", () => {
    for (const id of ["s1", "s2", "s3"]) visit(id);
    visit("s1");
    expect(ids()).toEqual(["s1", "s3", "s2"]);
  });

  test.serial("a later read of the same visit changes the row in place", () => {
    for (const id of ["s1", "s2", "s3"]) visit(id);
    // s2 opened from Recent, then its title changes while on screen
    pickRecent(recent.value[1], click);
    path.value = "/chat/s2";
    openChat("s2");
    openChat("s2", "renamed");
    expect(ids()).toEqual(["s3", "s2", "s1"]);
    expect(recent.value[1].title).toBe("renamed");
  });

  test.serial("a row opened from Recent keeps the order", () => {
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) visit(id);
    path.value = "/";
    for (const at of [3, 4]) {
      const row = recent.value[at];
      pickRecent(row, click);
      path.value = `/chat/${row.id}`;
      // the held row draws first, then the page's own read lands
      openChat(row.id);
      openChat(row.id, `${row.title}, read`);
      path.value = "/";
    }
    expect(ids()).toEqual(["s5", "s4", "s3", "s2", "s1"]);
    expect(recent.value[3].title).toBe("chat s2, read");
    // then a page opened from Home goes first
    visit("s1");
    expect(ids()).toEqual(["s1", "s5", "s4", "s3", "s2"]);
  });

  test.serial("an automation's tabs are one visit", () => {
    automations.value = [
      { id: "a1", projectId: "p1", name: "Digest" },
    ] as never;
    automationProject.value = { id: "a1", projectId: "p1" };
    path.value = "/automations/a1";
    visit("s1");
    visit("s2");
    path.value = "/";
    pickRecent(recent.value[2], click);
    path.value = "/automations/a1";
    path.value = "/automations/a1/memory";
    path.value = "/automations/a1/edit";
    path.value = "/automations/a1";
    expect(recent.value.map((r) => r.id)).toEqual(["s2", "s1", "a1"]);
  });

  test.serial(
    "an automation opened from Recent on its edit page keeps the order",
    () => {
      automations.value = [
        { id: "a1", projectId: "p1", name: "Digest" },
      ] as never;
      automationProject.value = { id: "a1", projectId: "p1" };
      path.value = "/automations/a1";
      visit("s1");
      visit("s2");
      path.value = "/";
      path.value = "/automations/a1/edit";
      pickRecent(recent.value[2], click);
      path.value = "/automations/a1";
      expect(ids()).toEqual(["s2", "s1", "a1"]);
    },
  );

  test.serial("a click on the page on screen marks nothing", () => {
    automations.value = [
      { id: "a1", projectId: "p1", name: "Digest" },
    ] as never;
    automationProject.value = { id: "a1", projectId: "p1" };
    path.value = "/automations/a1";
    visit("s1");
    visit("s2");
    // a1 opened another way, its row not read yet
    automationProject.value = null;
    path.value = "/";
    path.value = "/automations/a1";
    // its row clicked while on screen, then a tab of the same visit
    pickRecent(recent.value[2], click);
    path.value = "/automations/a1/memory";
    automationProject.value = { id: "a1", projectId: "p1" };
    expect(ids()).toEqual(["a1", "s2", "s1"]);
  });

  test.serial("a click for a new tab marks nothing", () => {
    for (const id of ["s1", "s2"]) visit(id);
    path.value = "/";
    pickRecent(recent.value[1], { ...click, metaKey: true });
    path.value = "/chat/s1";
    openChat("s1");
    expect(ids()).toEqual(["s1", "s2"]);
  });

  test.serial(
    "a pick for a page never opened is gone by the next visit",
    () => {
      for (const id of ["s1", "s2"]) visit(id);
      path.value = "/";
      pickRecent(recent.value[1], click);
      path.value = "/projects";
      path.value = "/chat/s1";
      openChat("s1");
      expect(ids()).toEqual(["s1", "s2"]);
    },
  );
});

describe("one list per user", () => {
  test.serial("another user's list is never shown", () => {
    visit("s1");
    me.value = robin;
    expect(recent.value).toEqual([]);
    visit("s2");
    expect(stored("u2").map((r: RecentRow) => r.id)).toEqual(["s2"]);
    me.value = casey;
    expect(ids()).toEqual(["s1"]);
  });

  test.serial("signing out empties the rail and keeps the list", () => {
    visit("s1");
    me.value = null;
    expect(recent.value).toEqual([]);
    me.value = casey;
    expect(ids()).toEqual(["s1"]);
  });

  test.serial("a stored list is read on sign in", () => {
    stop();
    me.value = null;
    store.set(recentStoreKey("u1"), JSON.stringify([chatRow("s9")]));
    stop = watchRecent();
    me.value = casey;
    expect(ids()).toEqual(["s9"]);
  });

  test.serial("a storage that refuses keeps the list for the tab", () => {
    full = true;
    visit("s1");
    visit("s2");
    expect(ids()).toEqual(["s2", "s1"]);
    expect(store.size).toBe(0);
  });

  test.serial("without storage the list starts empty", () => {
    stop();
    me.value = null;
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    stop = watchRecent();
    me.value = casey;
    expect(recent.value).toEqual([]);
    visit("s1");
    expect(ids()).toEqual(["s1"]);
  });
});

describe("the rail's Recent", () => {
  const rail = () =>
    render(<Rail user={casey} narrow={false} onHide={() => {}} />);

  test.serial("draws nothing while nothing is recorded", () => {
    expect(rail()).not.toContain("Recent");
  });

  test.serial("sits between Directory and Projects", () => {
    projects.value = [];
    visit("s1");
    path.value = "/";
    const html = rail();
    const at = (s: string) => html.indexOf(s);
    expect(at('href="/directory"')).toBeLessThan(at(">Recent<"));
    expect(at(">Recent<")).toBeLessThan(at('href="/chat/s1"'));
    expect(at('href="/chat/s1"')).toBeLessThan(at('href="/projects"'));
    expect(html).toContain(
      '<a href="/chat/s1" class="rail-sub rail-sub-icon rail-recent" title="chat s1">',
    );
  });

  test.serial("lights the page on screen", () => {
    visit("s1");
    expect(rail()).toContain(
      'class="rail-sub rail-sub-icon rail-recent rail-sub-on" aria-current="page"',
    );
  });

  test.serial("draws a run in words and a file as a path", () => {
    path.value = "/run/r1";
    openRun("r1", "a1");
    path.value = "/projects/p1/knowledge/files/f1";
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
    const html = rail();
    expect(html).toContain('title="Run of Digest"');
    expect(html).toContain('<span class="pathname-dir cut">plans/</span>');
  });

  test.serial("is never on the admin face", () => {
    visit("s1");
    path.value = "/admin/monitor";
    const html = render(
      <Rail
        user={{ ...casey, role: "admin" }}
        narrow={false}
        onHide={() => {}}
      />,
    );
    expect(html).not.toContain("Recent");
    expect(html).not.toContain('href="/chat/s1"');
  });
});
