// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's tab waits in RowsWaiting under the tabs while its row
// loads, and holds those bones as Page holds its own: a row landing
// just past the reveal keeps them SHOW_MS, so they never flash. Every
// step is on the fake clock, the frame mounted so its hooks run.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { project, projects } from "../../../src/client/data/projects.ts";
import type { DayClock } from "../../../src/client/lib/now.ts";
import {
  REVEAL_MS,
  SHOW_MS,
  setWaitClock,
} from "../../../src/client/lib/wait.ts";
import { Frame } from "../../../src/client/views/projects/Frame.tsx";
import type {
  ProjectDetail,
  ProjectSummary,
} from "../../../src/shared/contracts/project.ts";
import { fakeClock, mount } from "../../helpers/mount.ts";

const listed: ProjectSummary = {
  id: "p1",
  kind: "team",
  name: "infra",
  createdAt: 0,
  memberCount: 1,
};

const detail: ProjectDetail = {
  ...listed,
  description: "",
  members: [],
  labels: [],
  chats: 0,
  knowledge: { files: 0, tokens: 0 },
  latestFiles: [],
};

let clock: ReturnType<typeof fakeClock>;
let was: DayClock;

beforeEach(() => {
  clock = fakeClock();
  was = setWaitClock(clock);
  projects.value = [listed];
  project.value = null;
});

afterEach(() => {
  setWaitClock(was);
  projects.value = null;
  project.value = null;
});

const frame = () => (
  <Frame id="p1" tab="feed">
    {() => <p class="tab-body">the tab</p>}
  </Frame>
);

test.serial(
  "a row landing past the reveal keeps the bones SHOW_MS",
  async () => {
    const view = await mount(frame());
    // the head and the tabs from the rail's list, the tab in bones
    expect(view.html()).toContain(">infra<");
    expect(view.html()).toContain('aria-label="Loading the project"');
    await clock.advance(REVEAL_MS + 10);
    await act(() => {
      project.value = detail;
    });
    expect(view.html()).toContain('aria-label="Loading the project"');
    expect(view.html()).not.toContain("the tab");
    await clock.advance(SHOW_MS - 11);
    expect(view.html()).not.toContain("the tab");
    await clock.advance(1);
    expect(view.html()).toContain("the tab");
    expect(view.html()).not.toContain('aria-label="Loading the project"');
    await view.unmount();
  },
);

test.serial(
  "a row landing before the reveal draws the tab at once",
  async () => {
    const view = await mount(frame());
    await clock.advance(REVEAL_MS - 1);
    await act(() => {
      project.value = detail;
    });
    expect(view.html()).toContain("the tab");
    expect(view.html()).not.toContain("rows-waiting");
    await view.unmount();
  },
);
