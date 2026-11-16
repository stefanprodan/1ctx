// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A wait says so in words only once it is slow: useSlow turns true when
// loading has held SLOW_MS, false again when it ends, and never when the
// load lands first. Page's head and a board's Loaded follow it. Every
// step is on the fake clock, the views mounted so their hooks run.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DayClock } from "../../../src/client/lib/now.ts";
import {
  CARRY_MS,
  dropCarried,
  SLOW_MS,
  useSlow,
  useWaited,
} from "../../../src/client/lib/slow.ts";
import { setWaitClock } from "../../../src/client/lib/wait.ts";
import { Loaded } from "../../../src/client/ui/Loaded.tsx";
import { Page } from "../../../src/client/ui/Page.tsx";
import { fakeClock, mount } from "../../helpers/mount.ts";

let clock: ReturnType<typeof fakeClock>;
let was: DayClock;

beforeEach(() => {
  clock = fakeClock();
  was = setWaitClock(clock);
});

afterEach(() => {
  setWaitClock(was);
  dropCarried();
});

function Probe({ loading }: { loading: boolean }) {
  return <p>{useSlow(loading) ? "slow" : "quick"}</p>;
}

test.serial(
  "slow once loading has held SLOW_MS, quick again after",
  async () => {
    const view = await mount(<Probe loading />);
    expect(view.html()).toBe("<p>quick</p>");
    await clock.advance(SLOW_MS - 1);
    expect(view.html()).toBe("<p>quick</p>");
    await clock.advance(1);
    expect(view.html()).toBe("<p>slow</p>");
    await view.update(<Probe loading={false} />);
    expect(view.html()).toBe("<p>quick</p>");
    // a load that starts again counts from its own start
    await view.update(<Probe loading />);
    expect(view.html()).toBe("<p>quick</p>");
    await clock.advance(SLOW_MS);
    expect(view.html()).toBe("<p>slow</p>");
    await view.unmount();
  },
);

test.serial("a load that lands first is never slow", async () => {
  const view = await mount(<Probe loading />);
  await clock.advance(SLOW_MS - 10);
  await view.update(<Probe loading={false} />);
  expect(clock.pending()).toBe(0);
  await clock.advance(SLOW_MS);
  expect(view.html()).toBe("<p>quick</p>");
  // never loading, never slow
  await view.update(<Probe loading={false} />);
  expect(view.html()).toBe("<p>quick</p>");
  await view.unmount();
});

test.serial("Page says Still loading in its head once slow", async () => {
  const page = (loading: boolean) => (
    <Page crumb="" title="Agents" loading={loading}>
      <p>rows</p>
    </Page>
  );
  const view = await mount(page(true));
  // the live region is there from the start, empty, so a reader hears
  // the words land in it
  expect(view.html()).toContain('aria-live="polite"></p>');
  expect(view.html()).not.toContain("Still loading");
  await clock.advance(SLOW_MS);
  const slow = view.html();
  expect(slow).toContain('aria-live="polite">Still loading</p>');
  expect(slow.match(/role="status"/g)?.length).toBe(1);
  // in the head, beside the body's own status
  const head = slow.slice(0, slow.indexOf('class="card rows-card'));
  expect(head).toContain("page-slow");
  await view.update(page(false));
  expect(view.html()).not.toContain("Still loading");
  await view.unmount();
});

test.serial("a board's first load says Loading only once slow", async () => {
  const board = (busy: boolean, readAt: number | null) => (
    <Loaded readAt={readAt} busy={busy} error={null} onRefresh={() => {}} />
  );
  const view = await mount(board(true, null));
  expect(view.html()).not.toContain("Loading");
  await clock.advance(SLOW_MS);
  expect(view.html()).toContain(">Loading<");
  await view.update(board(false, 5));
  expect(view.html()).not.toContain("Loading");
  // a refresh keeps what is drawn and says so at once
  await view.update(board(true, 5));
  expect(view.html()).toContain(">Refreshing<");
  await view.unmount();
});

function Carried({ loading }: { loading: boolean }) {
  return <p>{useWaited(loading, "wait").slow ? "slow" : "quick"}</p>;
}

test.serial(
  "a named wait taken up by the next page keeps its start",
  async () => {
    const first = await mount(<Carried loading />);
    await clock.advance(SLOW_MS - 100);
    await first.unmount();
    // the next page takes it up within CARRY_MS: slow at the old start
    const next = await mount(<Carried loading />);
    expect(next.html()).toBe("<p>quick</p>");
    await clock.advance(100);
    expect(next.html()).toBe("<p>slow</p>");
    // an ended wait leaves nothing to carry
    await next.update(<Carried loading={false} />);
    await next.update(<Carried loading />);
    await clock.advance(SLOW_MS - 1);
    expect(next.html()).toBe("<p>quick</p>");
    await next.unmount();
    // left past CARRY_MS, the name is a new wait's
    await clock.advance(CARRY_MS + 1);
    const late = await mount(<Carried loading />);
    await clock.advance(SLOW_MS - 1);
    expect(late.html()).toBe("<p>quick</p>");
    await late.unmount();
  },
);
