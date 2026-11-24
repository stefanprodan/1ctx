// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell's wait for me and the page's own are one wait: when me lands
// the body mounts anew, so the shell's main carries --waited, and bones
// drawn under it start as far into their reveal as the wait has gone
// rather than replaying it; the page goes on with the shell's start, so
// its hold counts from there too. A wait that ends before the reveal
// carries nothing, and the shell lets go HANDED_MS after it ends. Every
// step is on the fake clock, the shell mounted so its hooks run.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { App } from "../../../src/client/app/App.tsx";
import { path } from "../../../src/client/app/router.ts";
import { match } from "../../../src/client/app/routes.ts";
import { me, meError } from "../../../src/client/data/me.ts";
import { projects } from "../../../src/client/data/projects.ts";
import type { DayClock } from "../../../src/client/lib/now.ts";
import {
  HANDED_MS,
  REVEAL_MS,
  SHOW_MS,
  setWaitClock,
} from "../../../src/client/lib/wait.ts";
import { fakeClock, mount } from "../../helpers/mount.ts";

const realFetch = globalThis.fetch;
let clock: ReturnType<typeof fakeClock>;
let was: DayClock;

const user = {
  id: "u1",
  username: "casey",
  fullName: "Casey",
  role: "member" as const,
};

// the shell's main: its classes and its --waited, if any
function shellMain(html: string): { carried: boolean; waited: number | null } {
  const tag = html.match(/<main class="([^"]*)"(?: style="([^"]*)")?/);
  const waited = tag?.[2]?.match(/--waited:\s*(\d+)ms/)?.[1];
  return {
    carried: tag?.[1]?.split(" ").includes("bones-waited") ?? false,
    waited: waited === undefined ? null : Number(waited),
  };
}

beforeEach(async () => {
  clock = fakeClock();
  was = setWaitClock(clock);
  // nothing answers: the test lands every signal by hand
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
  path.value = "/projects";
  // the view's code is in, so me is the only wait the shell hands over
  await match("/projects")!.route.view.load();
  me.value = undefined;
  meError.value = null;
  projects.value = null;
});

afterEach(() => {
  setWaitClock(was);
  globalThis.fetch = realFetch;
  me.value = undefined;
  projects.value = null;
  path.value = "/";
});

test.serial(
  "bones drawn when me lands go on with the shell's reveal",
  async () => {
    const view = await mount(<App />);
    expect(view.html()).toContain('aria-label="Loading 1ctx"');
    expect(shellMain(view.html()).carried).toBe(false);
    await clock.advance(REVEAL_MS + 100);
    await act(() => {
      me.value = user;
    });
    // the page's bones, mounted anew, start 300 ms into the wait
    const landed = view.html();
    expect(landed).toContain('aria-label="Loading projects"');
    expect(shellMain(landed)).toEqual({
      carried: true,
      waited: REVEAL_MS + 100,
    });
    // the page goes on with that start: its own --waited says so too
    expect(landed).toMatch(
      /class="page bones-waited" style="--waited:\s*300ms/,
    );
    // the list lands past the reveal: held SHOW_MS from the shell's
    // reveal, not from the page's own mount
    await clock.advance(50);
    await act(() => {
      projects.value = [];
    });
    expect(view.html()).toContain('aria-label="Loading projects"');
    await clock.advance(SHOW_MS - 150 - 1);
    expect(view.html()).toContain('aria-label="Loading projects"');
    await clock.advance(1);
    expect(view.html()).not.toContain('aria-label="Loading projects"');
    // the shell lets go once its bones ran their reveal
    await clock.advance(HANDED_MS);
    expect(shellMain(view.html()).carried).toBe(false);
    await view.unmount();
  },
);

test.serial("a me that lands before the reveal carries nothing", async () => {
  const view = await mount(<App />);
  await clock.advance(REVEAL_MS - 50);
  await act(() => {
    me.value = user;
  });
  // nothing was shown yet, so the page's bones take their own reveal
  expect(view.html()).toContain('aria-label="Loading projects"');
  expect(shellMain(view.html()).carried).toBe(false);
  expect(view.html()).not.toContain("bones-waited");
  await view.unmount();
});
