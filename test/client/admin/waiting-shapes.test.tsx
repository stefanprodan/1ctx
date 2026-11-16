// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A first load waits in the page's landed layout, not three rows in a
// card: the board's charts and cards under their own labels, the tabs
// and the aside it lands with, an object's cards and a new object's
// form in bones, a task's head, files and activity, and a file's crumb
// in the steps it lands with. Usage, with no Loaded in its head, says a
// slow first load in the page's own line on the waits' clock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import { accessBoard } from "../../../src/client/data/access-board.ts";
import { adminProjects } from "../../../src/client/data/admin-projects.ts";
import { agents } from "../../../src/client/data/agents.ts";
import { taskPage } from "../../../src/client/data/external-task.ts";
import {
  overview,
  usage,
  usageLoading,
} from "../../../src/client/data/overview.ts";
import { project, projects } from "../../../src/client/data/projects.ts";
import { limits, tools } from "../../../src/client/data/tools.ts";
import { users } from "../../../src/client/data/users.ts";
import type { DayClock } from "../../../src/client/lib/now.ts";
import { SLOW_MS } from "../../../src/client/lib/slow.ts";
import { setWaitClock } from "../../../src/client/lib/wait.ts";
import { AccessBoard } from "../../../src/client/views/admin/AccessBoard.tsx";
import { AgentPage } from "../../../src/client/views/admin/AgentPage.tsx";
import { LIMITS_CARDS } from "../../../src/client/views/admin/Config.model.ts";
import { ConfigBoard } from "../../../src/client/views/admin/ConfigBoard.tsx";
import { NewUser } from "../../../src/client/views/admin/NewUser.tsx";
import { Overview } from "../../../src/client/views/admin/Overview.tsx";
import { Usage } from "../../../src/client/views/admin/Usage.tsx";
import { DocPage } from "../../../src/client/views/knowledge/file/DocPage.tsx";
import { ExternalTask } from "../../../src/client/views/projects/ExternalTask.tsx";
import { fakeClock, mount } from "../../helpers/mount.ts";

const count = (html: string, part: string) => html.split(part).length - 1;

describe("a board waits in its landed layout", () => {
  beforeEach(() => {
    accessBoard.value = null;
    users.value = null;
    adminProjects.value = null;
    tools.value = null;
    limits.value = null;
  });
  afterEach(() => {
    path.value = "/";
  });

  test.serial("Access: the chart, the cards and the aside's sections", () => {
    const html = render(<AccessBoard />);
    expect(html).toContain("split-aside");
    for (const label of ["Signed in", "Recently active", "Inactive"]) {
      expect(html).toContain(`>${label}<`);
    }
    // the aside's two sections, their lines in bones, quiet beside the
    // body's one status
    expect(count(html, "split-waiting")).toBe(2);
    expect(count(html, 'role="status"')).toBe(1);
    // never the generic card of three rows under a bone label
    expect(html).not.toContain("card rows-card rows-waiting");
  });

  test.serial("Config: the tabs, the Instance aside, each tab's cards", () => {
    path.value = "/admin/config";
    let html = render(<ConfigBoard />);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(">Built-in tools<");
    expect(html).toContain(">Instance<");
    expect(html).toContain("split-waiting");
    expect(count(html, 'role="status"')).toBe(1);
    path.value = "/admin/config/limits";
    html = render(<ConfigBoard />);
    // the limits cards' titles are the client's own, so they wait in
    // words, a field's bones for each limit
    for (const group of LIMITS_CARDS) {
      expect(html).toContain(`>${group.title}<`);
    }
    const fields = LIMITS_CARDS.reduce((n, g) => n + g.names.length, 0);
    expect(count(html, "bones-bone-field")).toBe(fields);
    expect(html).toContain("limits-setting-grid");
  });

  test.serial("Monitor's stats wait with their two chart panels", () => {
    overview.value = null;
    const html = render(<Overview />);
    expect(html).toContain(">Activity<");
    expect(html).toContain(">LLM response time<");
  });
});

describe("an object or a new one waits as its cards", () => {
  beforeEach(() => {
    agents.value = null;
    users.value = null;
  });

  test.serial("an agent's page: the tabs with no count, its cards", () => {
    path.value = "/admin/config/agents/sol";
    const html = render(<AgentPage params={{ name: "sol" }} />);
    expect(html).toContain('aria-label="Loading the agent"');
    expect(html).toContain(">General<");
    expect(html).not.toContain("tabs-count");
    expect(html).toContain(">Identity<");
    expect(html).toContain("bones-bone-prompt");
    // the aside's usage and Used in, quiet beside the cards' one status
    expect(html).toContain(">Last 30 days<");
    expect(html).toContain(">Used in<");
    expect(count(html, 'role="status"')).toBe(1);
    expect(html).not.toContain('aria-label="Loading usage"');
    path.value = "/";
  });

  test.serial("a new user: one card of field bones over its foot", () => {
    const html = render(<NewUser />);
    expect(html).toContain('aria-label="Loading the new user form"');
    expect(count(html, "bones-bone-field")).toBe(4);
    expect(count(html, "bones-bone-seg")).toBe(2);
    expect(count(html, "bones-bone-button")).toBe(2);
  });
});

describe("a task and a file wait in their own shape", () => {
  afterEach(() => {
    taskPage.value = null;
    project.value = null;
    projects.value = null;
  });

  test.serial("a task: its title, status, files and activity", () => {
    taskPage.value = null;
    const html = render(<ExternalTask params={{ id: "t1" }} />);
    expect(html).toContain('aria-label="Loading the task"');
    expect(html).toContain("external-tasks-title");
    expect(html).toContain(">Files<");
    expect(html).toContain(">Activity<");
    expect(html).toContain(">Task<");
    // the head is the one status; the aside and the activity are quiet
    expect(count(html, 'role="status"')).toBe(1);
  });

  test.serial("a cold file's crumb holds a folder's step and the name", () => {
    const html = render(<DocPage params={{ id: "p1", fileId: "f1" }} />);
    // the project, the folder and the name, each a bone, after Knowledge
    expect(html).toContain(">Knowledge<");
    expect(count(html, "page-crumb-bone")).toBe(3);
  });
});

describe("Usage says a slow first load", () => {
  let clock: ReturnType<typeof fakeClock>;
  let was: DayClock;
  beforeEach(() => {
    clock = fakeClock();
    was = setWaitClock(clock);
    usage.value = null;
    usageLoading.value = true;
  });
  afterEach(() => {
    setWaitClock(was);
    usageLoading.value = false;
  });

  test.serial("in the page's head once the load holds SLOW_MS", async () => {
    const view = await mount(<Usage />);
    expect(view.html()).not.toContain("Still loading");
    await clock.advance(SLOW_MS);
    expect(view.html()).toContain(">Still loading<");
    await view.unmount();
  });
});
