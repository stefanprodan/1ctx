// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell around a view: on a wide window the rail is a column that
// folds to a strip with the button that unfolds it, and the choice is
// kept; on a phone the rail covers the screen, starts closed, and the
// button floats over the view.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "preact-render-to-string";
import { App } from "../../../src/client/app/App.tsx";
import { path, query } from "../../../src/client/app/router.ts";
import { match } from "../../../src/client/app/routes.ts";
import {
  closeDrawer,
  DRAWER,
  drawerOpen,
  hideRail,
  lastAdmin,
  lastWork,
  NARROW,
  narrow,
  openDrawer,
  railDrawer,
  railHidden,
  showRail,
  watchPages,
  watchScreen,
  watchViewport,
} from "../../../src/client/app/shell.ts";
import { me } from "../../../src/client/data/me.ts";
import { MONITOR_HREF } from "../../../src/client/lib/hrefs.ts";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey",
    role: "member",
    mustChangePassword: false,
  };
  path.value = "/";
  lastWork.value = "/";
  lastAdmin.value = MONITOR_HREF;
  narrow.value = false;
  railDrawer.value = false;
  showRail();
  closeDrawer();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the shell on a wide window", () => {
  test("shows the rail and no strip", () => {
    const html = render(<App />);
    expect(html).toContain('class="rail"');
    expect(html).not.toContain("shell-strip");
    expect(html).not.toContain("shell-show");
    expect(html).toContain('aria-label="Hide the menu"');
  });

  test("hiding the rail folds it to the strip and keeps the choice", () => {
    hideRail();
    expect(railHidden.value).toBe(true);
    expect(store.get("rail")).toBe("hidden");
    const html = render(<App />);
    expect(html).not.toContain('class="rail"');
    expect(html).toContain("shell-strip");
    expect(html).toContain("shell-show");
    expect(html).not.toContain("shell-show-float");
    showRail();
    expect(store.has("rail")).toBe(false);
  });

  test("a hidden rail never becomes a drawer", () => {
    hideRail();
    expect(render(<App />)).not.toContain("rail-drawer");
  });
});

describe("the shell on a phone", () => {
  beforeEach(() => {
    railDrawer.value = true;
  });

  test("shows the floating button and no rail until it opens", () => {
    const closed = render(<App />);
    expect(closed).toContain("shell-show-float");
    expect(closed).not.toContain("shell-strip");
    expect(closed).not.toContain('class="rail');
    openDrawer();
    const opened = render(<App />);
    expect(opened).toContain('class="rail rail-drawer"');
    expect(opened).not.toContain("shell-show");
    expect(opened).toContain('aria-label="Close the menu"');
  });

  test("the full-screen rail ignores the kept desktop choice", () => {
    hideRail();
    openDrawer();
    expect(render(<App />)).toContain("rail-drawer");
    expect(drawerOpen.value).toBe(true);
  });

  test("the view under the open drawer is inert", () => {
    expect(render(<App />)).not.toContain("inert");
    openDrawer();
    expect(render(<App />)).toContain('<main class="shell-main" inert');
  });
});

describe("watchScreen", () => {
  type Listener = (event: unknown) => void;
  let matches: Record<string, boolean>;
  let listeners: Listener[];
  const fakeMatchMedia = (query: string) => {
    expect([NARROW, DRAWER]).toContain(query);
    return {
      get matches() {
        return matches[query];
      },
      addEventListener: (_: string, fn: Listener) => void listeners.push(fn),
    };
  };
  const resize = (width: boolean, drawer: boolean) => {
    matches = { [NARROW]: width, [DRAWER]: drawer };
    for (const fn of listeners) fn({});
  };

  beforeEach(() => {
    listeners = [];
    (globalThis as { matchMedia?: unknown }).matchMedia = fakeMatchMedia;
  });

  afterEach(() => {
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  test.serial(
    "follows the window and closes a drawer left open when it widens",
    () => {
      matches = { [NARROW]: true, [DRAWER]: true };
      watchScreen();
      expect(narrow.value).toBe(true);
      expect(railDrawer.value).toBe(true);
      openDrawer();
      resize(false, false);
      expect(narrow.value).toBe(false);
      expect(railDrawer.value).toBe(false);
      expect(drawerOpen.value).toBe(false);
      resize(true, true);
      expect(railDrawer.value).toBe(true);
      expect(drawerOpen.value).toBe(false);
    },
  );

  test.serial("a short wide window keeps the drawer open", () => {
    matches = { [NARROW]: true, [DRAWER]: true };
    watchScreen();
    openDrawer();
    resize(false, true);
    expect(narrow.value).toBe(false);
    expect(railDrawer.value).toBe(true);
    expect(drawerOpen.value).toBe(true);
  });

  test.serial("does nothing without matchMedia", () => {
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
    watchScreen();
    expect(narrow.value).toBe(false);
    expect(railDrawer.value).toBe(false);
  });
});

describe("the drawer's query", () => {
  const sheet = (name: string) =>
    readFileSync(
      new URL(`../../../src/client/${name}`, import.meta.url),
      "utf8",
    );

  test("is narrow or short", () => {
    expect(DRAWER.startsWith(`${NARROW}, `)).toBe(true);
    expect(DRAWER).toContain("max-height");
  });

  test("is the one the stylesheets place the floating button by", () => {
    expect(sheet("app/shell.css")).toContain(`@media ${DRAWER} {`);
    expect(sheet("ui/page.css")).toContain(`@media ${DRAWER} {`);
  });
});

describe("watchViewport", () => {
  type Listener = () => void;
  const g = globalThis as { window?: unknown; document?: unknown };
  let listeners: Map<string, Listener>;
  let props: Map<string, string>;
  let scrolled: number;
  let shell: boolean;
  const view = { height: 800, scale: 1, pageTop: 0 };

  beforeEach(() => {
    listeners = new Map();
    props = new Map();
    scrolled = 0;
    shell = true;
    Object.assign(view, { height: 800, scale: 1, pageTop: 0 });
    g.window = {
      visualViewport: {
        get height() {
          return view.height;
        },
        get scale() {
          return view.scale;
        },
        get pageTop() {
          return view.pageTop;
        },
        addEventListener: (type: string, fn: Listener) =>
          void listeners.set(type, fn),
      },
      scrollTo: () => void scrolled++,
    };
    g.document = {
      documentElement: {
        clientHeight: 800,
        style: {
          setProperty: (k: string, v: string) => void props.set(k, v),
          removeProperty: (k: string) => void props.delete(k),
        },
      },
      querySelector: () => (shell ? {} : null),
    };
  });

  afterEach(() => {
    delete g.window;
    delete g.document;
  });

  // the keyboard resizes the visual viewport; the browser's own scroll
  // to the field moves it
  const move = (type: string, next: Partial<typeof view>) => {
    Object.assign(view, next);
    listeners.get(type)?.();
  };

  test.serial("sizes the shell to the keyboard's edge and back", () => {
    watchViewport();
    move("resize", { height: 450 });
    expect(props.get("--shell-height")).toBe("450px");
    expect(scrolled).toBe(0);
    move("scroll", { pageTop: 300 });
    expect(scrolled).toBe(1);
    move("resize", { height: 800, pageTop: 0 });
    expect(props.has("--shell-height")).toBe(false);
    expect(scrolled).toBe(1);
  });

  test.serial("a page without the shell keeps its scroll", () => {
    shell = false;
    watchViewport();
    move("scroll", { height: 450, pageTop: 300 });
    expect(scrolled).toBe(0);
  });
});

describe("the rail's faces", () => {
  const admin = () => {
    me.value = { ...me.value!, role: "admin" };
  };

  test.serial("the working face offers an admin the admin panel", () => {
    admin();
    const html = render(<App />);
    expect(html).toContain("Admin panel");
    expect(html).not.toContain("Exit admin panel");
    expect(html).not.toContain('href="/admin/access/users"');
  });

  test.serial("a member gets no band", () => {
    expect(render(<App />)).not.toContain("Admin panel");
  });

  test.serial("an admin address shows the zones and the way back", () => {
    admin();
    path.value = "/admin/config/agents/assistant";
    const html = render(<App />);
    expect(html).toContain("Exit admin panel");
    expect(html).toContain('class="rail-face"');
    expect(html).toContain('href="/admin/monitor"');
    expect(html).toContain('href="/admin/access/users"');
    expect(html).toMatch(/class="rail-sub rail-sub-on"[^>]*>Agents</);
    expect(html).not.toContain('href="/projects"');
  });

  test.serial("the band opens the last page seen on the other face", () => {
    const stop = watchPages((p) => match(p) !== null);
    try {
      path.value = "/";
      path.value = "/admin/config/mcp";
      query.value = "?q=x";
      expect(lastAdmin.value).toBe("/admin/config/mcp?q=x");
      query.value = "";
      path.value = "/projects";
      expect(lastWork.value).toBe("/projects");
      path.value = "/login";
      expect(lastWork.value).toBe("/projects");
      expect(lastAdmin.value).toBe("/admin/config/mcp");
      path.value = "/admin";
      expect(lastWork.value).toBe("/projects");
      path.value = "/admin/monitor/typo";
      expect(lastAdmin.value).toBe("/admin/config/mcp");
    } finally {
      stop();
    }
  });
});
