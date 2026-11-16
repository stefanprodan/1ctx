// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A search box swapped for another in one render hands over its focus
// and text only when both are bound to the same query: a list's waiting
// card for its landed one. Two pages' boxes that only say the same
// words (Home's and a project Feed's Search sessions) share nothing, so
// a route change while one is focused never moves text into the next.

import { expect, test } from "bun:test";
import { type Signal, signal } from "@preact/signals";
import { Search } from "../../../src/client/ui/Search.tsx";
import { mount } from "../../helpers/mount.ts";

function Swap({
  at,
  first,
  second,
}: {
  at: number;
  first: Signal<string>;
  second: Signal<string>;
}) {
  // keyed, so the swap mounts a new box as a card's swap does
  return at === 0 ? (
    <Search key="a" query={first} placeholder="Search sessions" />
  ) : (
    <Search key="b" query={second} placeholder="Search sessions" />
  );
}

test.serial("a swap over the same query keeps the focus and text", async () => {
  const q = signal("");
  const view = await mount(<Swap at={0} first={q} second={q} />);
  await view.type("search-input", "deploy");
  expect(q.value).toBe("deploy");
  await view.update(<Swap at={1} first={q} second={q} />);
  expect(view.focused("search-input")).toBe(true);
  expect(view.html()).toContain('value="deploy"');
  expect(q.value).toBe("deploy");
  await view.unmount();
});

test.serial(
  "a box of the same words over another query takes nothing",
  async () => {
    const home = signal("");
    const feed = signal("");
    let calls = 0;
    feed.subscribe(() => {
      calls++;
    });
    const view = await mount(<Swap at={0} first={home} second={feed} />);
    await view.type("search-input", "deploy");
    expect(home.value).toBe("deploy");
    await view.update(<Swap at={1} first={home} second={feed} />);
    expect(view.focused("search-input")).toBe(false);
    expect(view.html()).not.toContain("deploy");
    expect(feed.value).toBe("");
    // the subscription's first call is its own, never a write
    expect(calls).toBe(1);
    await view.unmount();
  },
);
