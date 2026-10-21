// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Recent watcher records a page once the row it shows is read,
// places it once per visit, keeps the order for a page opened from the
// list, keeps one list per user in localStorage; the rail draws it
// between Directory and Projects on the working face only, each row's
// icon in its live status, which is never stored.

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
  recentStatus,
  recentStoreKey,
  watchRecent,
} from "../../../src/client/app/Recent.state.ts";
import { path } from "../../../src/client/app/router.ts";
import {
  automationError,
  automationProject,
  automations,
} from "../../../src/client/data/automations.ts";
import {
  TASK_DELETED,
  taskError,
  taskPage,
} from "../../../src/client/data/external-task.ts";
import { docFiles } from "../../../src/client/data/knowledge-file.ts";
import { me } from "../../../src/client/data/me.ts";
import { projects } from "../../../src/client/data/projects.ts";
import { session, sessionError } from "../../../src/client/data/sessions.ts";
import { startSocket } from "../../../src/client/data/socket.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";
import { PROTOCOL } from "../../../src/shared/socket.ts";
import { FakeWire } from "../../helpers/client-socket.ts";

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
  sessionError.value = null;
  automationError.value = null;
  taskError.value = null;
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

describe("a gone row leaves", () => {
  const notFound = { words: "Not found", status: 404 };

  test.serial("a chat that answers not found drops its row", () => {
    visit("s1");
    visit("s2");
    path.value = "/";
    path.value = "/chat/s1";
    session.value = null;
    sessionError.value = { ...notFound };
    expect(ids()).toEqual(["s2"]);
    expect(stored().map((r: RecentRow) => r.id)).toEqual(["s2"]);
  });

  test.serial("another failure keeps the row", () => {
    visit("s1");
    path.value = "/";
    path.value = "/chat/s1";
    sessionError.value = { words: "Server error", status: 500 };
    expect(ids()).toEqual(["s1"]);
  });

  test.serial("the page before's not found never drops the next", () => {
    visit("s1");
    path.value = "/chat/gone";
    sessionError.value = { ...notFound };
    // the next chat opened while the old failure still shows
    path.value = "/chat/s1";
    expect(ids()).toEqual(["s1"]);
    // its own load clears it, then answers not found
    sessionError.value = null;
    sessionError.value = { ...notFound };
    expect(ids()).toEqual([]);
  });

  test.serial("an automation and a task drop on not found", () => {
    automations.value = [
      { id: "a1", projectId: "p1", name: "Digest" },
    ] as never;
    automationProject.value = { id: "a1", projectId: "p1" };
    path.value = "/automations/a1";
    path.value = "/external-tasks/t1";
    taskPage.value = {
      id: "t1",
      detail: { task: { id: "t1", projectId: "p1", title: "Fix it" } },
    } as never;
    expect(ids()).toEqual(["t1", "a1"]);
    taskPage.value = null;
    taskError.value = TASK_DELETED;
    expect(ids()).toEqual(["a1"]);
    automationProject.value = null;
    path.value = "/automations/a1";
    automationError.value = { ...notFound };
    expect(ids()).toEqual([]);
  });

  test.serial("a file missing or deleted drops its row", () => {
    const done = (deleted: unknown) =>
      ({
        state: "done",
        file: { id: "f1", projectId: "p1", name: "x.md" },
        newer: null,
        deleted,
        failure: null,
      }) as never;
    path.value = "/projects/p1/knowledge/files/f1";
    docFiles.value = new Map([["f1", done(null)]]);
    expect(ids()).toEqual(["f1"]);
    docFiles.value = new Map([["f1", done({ at: 1 })]]);
    expect(ids()).toEqual([]);
    // a read later in the visit never adds it back
    docFiles.value = new Map([["f1", done(null)]]);
    expect(ids()).toEqual([]);
    path.value = "/";
    path.value = "/projects/p1/knowledge/files/f1";
    expect(ids()).toEqual(["f1"]);
    docFiles.value = new Map([["f1", { state: "missing" }]]);
    expect(ids()).toEqual([]);
  });

  test.serial("a delete frame drops the row and stores the list", () => {
    const wire = new FakeWire();
    const stopSocket = startSocket({ connect: () => wire });
    try {
      visit("s1");
      visit("s2");
      path.value = "/";
      wire.message(
        JSON.stringify({ type: "deleted", projectId: "p1", sessionId: "s1" }),
      );
      expect(ids()).toEqual(["s2"]);
      expect(stored().map((r: RecentRow) => r.id)).toEqual(["s2"]);
    } finally {
      stopSocket();
    }
  });

  test.serial("a run read after its automation's rename keeps the name", () => {
    const wire = new FakeWire();
    const stopSocket = startSocket({ connect: () => wire });
    try {
      automations.value = [
        { id: "a1", projectId: "p1", name: "Digest" },
      ] as never;
      path.value = "/run/r1";
      openRun("r1", "a1", "Digest");
      path.value = "/";
      wire.message(
        JSON.stringify({
          type: "automation",
          projectId: "p1",
          automation: { id: "a1", projectId: "p1", name: "Weekly" },
        }),
      );
      expect(recent.value.map((r) => r.title)).toEqual(["Weekly"]);
      // the run page's list has the new name; the run keeps the old one
      automations.value = [
        { id: "a1", projectId: "p1", name: "Weekly" },
      ] as never;
      path.value = "/run/r1";
      session.value = null;
      openRun("r1", "a1", "Digest");
      expect(recent.value.map((r) => r.title)).toEqual(["Weekly"]);
      expect(stored().map((r: RecentRow) => r.title)).toEqual(["Weekly"]);
    } finally {
      stopSocket();
    }
  });

  test.serial("a frame applies to what another tab stored last", () => {
    const wire = new FakeWire();
    const stopSocket = startSocket({ connect: () => wire });
    try {
      visit("s1");
      visit("s2");
      path.value = "/";
      // another tab moved s3 to the top; its storage event is not here yet
      store.set(
        recentStoreKey("u1"),
        JSON.stringify([chatRow("s3"), chatRow("s2"), chatRow("s1")]),
      );
      wire.message(
        JSON.stringify({ type: "deleted", projectId: "p1", sessionId: "s1" }),
      );
      expect(ids()).toEqual(["s3", "s2"]);
      expect(stored().map((r: RecentRow) => r.id)).toEqual(["s3", "s2"]);
    } finally {
      stopSocket();
    }
  });
});

describe("tabs keep one list", () => {
  const from = (key: string | null, newValue: string | null) => {
    globalThis.dispatchEvent(
      Object.assign(new Event("storage"), { key, newValue }),
    );
  };

  test.serial("another tab's list replaces the held one", () => {
    visit("s1");
    const writes: string[] = [];
    const setItem = fakeStorage.setItem;
    fakeStorage.setItem = (k, v) => {
      writes.push(k);
      setItem(k, v);
    };
    try {
      from(
        recentStoreKey("u1"),
        JSON.stringify([chatRow("s7"), chatRow("s1")]),
      );
      expect(ids()).toEqual(["s7", "s1"]);
      // taken, never written back
      expect(writes).toEqual([]);
    } finally {
      fakeStorage.setItem = setItem;
    }
  });

  test.serial("a bad value is dropped as on read", () => {
    visit("s1");
    from(recentStoreKey("u1"), "{not json");
    expect(ids()).toEqual([]);
    from(
      recentStoreKey("u1"),
      JSON.stringify([{ kind: "nope", id: "x" }, chatRow("s3")]),
    );
    expect(ids()).toEqual(["s3"]);
  });

  test.serial("another user's key changes nothing", () => {
    visit("s1");
    from(recentStoreKey("u2"), JSON.stringify([chatRow("s7")]));
    from("theme", "dark");
    expect(ids()).toEqual(["s1"]);
  });

  test.serial("a cleared storage empties the list", () => {
    visit("s1");
    from(null, null);
    expect(ids()).toEqual([]);
  });

  test.serial("a row another tab pushed off never comes back", () => {
    visit("s1");
    // another tab pushed s1 off while it stays open here
    const others = ["s2", "s3", "s4", "s5", "s6"].map((id) => chatRow(id));
    from(recentStoreKey("u1"), JSON.stringify(others));
    openChat("s1", "renamed");
    expect(ids()).toEqual(["s2", "s3", "s4", "s5", "s6"]);
    // the next visit adds it again
    visit("s1");
    expect(ids()).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  test.serial("a stopped watcher listens to nothing", () => {
    visit("s1");
    stop();
    from(recentStoreKey("u1"), JSON.stringify([chatRow("s7")]));
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

describe("a row's live status", () => {
  const rail = () =>
    render(<Rail user={casey} narrow={false} onHide={() => {}} />);
  const PAUSE = 'd="M5.5 3.5v9M10.5 3.5v9"';
  const glyph = (tone?: string) =>
    `class="rail-sub-glyph${tone === undefined ? "" : ` status-${tone}`}"`;
  // a revision past every one before, as the server's frames carry
  let revision = 0;
  const summary = (id: string, status: string, origin: string) => ({
    id,
    projectId: "p1",
    origin,
    automationId: origin === "chat" ? null : "a1",
    title: origin === "chat" ? `chat ${id}` : "Digest",
    status,
    attention: null,
    archived: null,
    revision: ++revision,
  });
  // the page's read, in the shape the sessions layer applies frames to
  const openSession = (
    id: string,
    status: string,
    origin: "chat" | "automation" = "chat",
  ) => {
    session.value = {
      session: summary(id, status, origin),
      messages: [],
      send: null,
      sends: [],
      live: [],
    } as never;
  };
  const sessionFrame = (id: string, status: string, origin = "chat") =>
    JSON.stringify({
      type: "session",
      projectId: "p1",
      session: summary(id, status, origin),
      messages: [],
    });

  test.serial("the page read gives a row its status", () => {
    path.value = "/chat/s1";
    openSession("s1", "running");
    path.value = "/";
    expect(rail()).toContain(glyph("running"));
    // the page's own reads change it while it is open
    path.value = "/chat/s1";
    openSession("s1", "done");
    expect(rail()).toContain(glyph());
    expect(rail()).not.toContain("status-");
  });

  test.serial("a frame turns a row running, then plain when done", () => {
    const wire = new FakeWire();
    const stopSocket = startSocket({ connect: () => wire });
    try {
      path.value = "/chat/s1";
      openSession("s1", "done");
      // the chat's own page takes the frame too
      wire.message(sessionFrame("s1", "running"));
      expect(session.value?.session.status).toBe("running");
      expect(rail()).toContain(glyph("running"));
      // and so does its row while another page is open
      path.value = "/";
      wire.message(sessionFrame("s1", "done"));
      expect(rail()).not.toContain("status-");
      wire.message(sessionFrame("s1", "failed"));
      expect(rail()).toContain(glyph("failed"));
      // a frame for a session not held sets nothing
      const held = recentStatus.value;
      wire.message(sessionFrame("s9", "running"));
      expect(recentStatus.value).toBe(held);
    } finally {
      stopSocket();
    }
  });

  test.serial("a run row follows only the run it links to", () => {
    const wire = new FakeWire();
    const stopSocket = startSocket({ connect: () => wire });
    try {
      path.value = "/run/r1";
      openSession("r1", "failed", "automation");
      path.value = "/";
      expect(rail()).toContain(glyph("failed"));
      // a newer run of the automation, running elsewhere
      wire.message(sessionFrame("r2", "running", "automation"));
      expect(rail()).toContain(glyph("failed"));
      // opened, it takes the row and its own status; the old one goes
      path.value = "/run/r2";
      openSession("r2", "done", "automation");
      expect(recent.value.map((r) => r.id)).toEqual(["r2"]);
      expect(rail()).not.toContain("status-");
      expect(Object.keys(recentStatus.value)).toEqual(["run:r2"]);
    } finally {
      stopSocket();
    }
  });

  test.serial("an automation draws its pause and its last run", () => {
    const wire = new FakeWire();
    const stopSocket = startSocket({ connect: () => wire });
    try {
      const row = {
        id: "a1",
        projectId: "p1",
        name: "Digest",
        suspendedAt: 5,
        lastRunStatus: null,
      };
      automations.value = [row] as never;
      automationProject.value = { id: "a1", projectId: "p1" };
      path.value = "/automations/a1";
      path.value = "/";
      expect(rail()).toContain(PAUSE);
      wire.message(
        JSON.stringify({
          type: "automation",
          projectId: "p1",
          automation: { ...row, suspendedAt: null, lastRunStatus: "running" },
        }),
      );
      const html = rail();
      expect(html).not.toContain(PAUSE);
      expect(html).toContain(glyph("running"));
    } finally {
      stopSocket();
    }
  });

  test.serial("a task awaiting input takes the attention colour", () => {
    path.value = "/external-tasks/t1";
    const task = { id: "t1", projectId: "p1", title: "Fix it" };
    taskPage.value = {
      id: "t1",
      detail: { task: { ...task, state: "awaiting_input" } },
    } as never;
    expect(rail()).toContain(glyph("attention"));
    taskPage.value = {
      id: "t1",
      detail: { task: { ...task, state: "in_progress" } },
    } as never;
    expect(rail()).not.toContain("status-");
  });

  test.serial("a status leaves with its row", () => {
    const wire = new FakeWire();
    const stopSocket = startSocket({ connect: () => wire });
    try {
      path.value = "/chat/s1";
      openSession("s1", "done");
      // another chat is open when s1 runs and is deleted
      path.value = "/chat/s2";
      openSession("s2", "done");
      wire.message(sessionFrame("s1", "running"));
      expect(Object.keys(recentStatus.value).sort()).toEqual([
        "chat:s1",
        "chat:s2",
      ]);
      wire.message(
        JSON.stringify({ type: "deleted", projectId: "p1", sessionId: "s1" }),
      );
      expect(Object.keys(recentStatus.value)).toEqual(["chat:s2"]);
    } finally {
      stopSocket();
    }
  });

  test.serial("status is never stored, and a reload draws plain", () => {
    path.value = "/chat/s1";
    openSession("s1", "running");
    path.value = "/";
    expect(rail()).toContain(glyph("running"));
    expect(stored()).toEqual([chatRow("s1")]);
    expect(store.get(recentStoreKey("u1"))).not.toContain("running");
    // a reload: a fresh tab reads the stored list and nothing else
    stop();
    session.value = null;
    stop = watchRecent();
    expect(ids()).toEqual(["s1"]);
    expect(rail()).not.toContain("status-");
  });

  test.serial("a reopened socket drops what it may have missed", () => {
    let wire = new FakeWire();
    const timers: (() => void)[] = [];
    const stopSocket = startSocket({
      connect: () => wire,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    });
    try {
      wire.message(
        JSON.stringify({ type: "hello", protocol: PROTOCOL, version: "v1" }),
      );
      path.value = "/chat/s1";
      openSession("s1", "done");
      path.value = "/chat/s2";
      openSession("s2", "done");
      wire.message(sessionFrame("s1", "running"));
      wire.message(sessionFrame("s2", "running"));
      expect(Object.keys(recentStatus.value).sort()).toEqual([
        "chat:s1",
        "chat:s2",
      ]);
      // the laptop sleeps through s1's done frame
      const first = wire;
      wire = new FakeWire();
      first.fireClose(1006);
      expect(timers.length).toBe(1);
      timers[0]();
      wire.message(
        JSON.stringify({ type: "hello", protocol: PROTOCOL, version: "v1" }),
      );
      // the page on screen keeps its own, which its load refills
      expect(Object.keys(recentStatus.value)).toEqual(["chat:s2"]);
      path.value = "/";
      const html = rail();
      expect(html).toContain(glyph("running"));
      expect(html.match(/status-running/g)?.length).toBe(1);
    } finally {
      stopSocket();
    }
  });

  test.serial("another user signing in starts with no status", () => {
    path.value = "/chat/s1";
    openSession("s1", "running");
    me.value = robin;
    expect(recentStatus.value).toEqual({});
  });
});
