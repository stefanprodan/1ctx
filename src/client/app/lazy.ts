// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A view loaded on first use, so the route table names every view
// without putting every view in the first bundle. The loader runs once
// per attempt; until it answers the component renders a page's shape in
// bones (the route's own when it names one), then re-renders through
// its signal. A loader that fails renders the reason and a retry, and
// the next render or load() tries again.

import { signal } from "@preact/signals";
import { type Attributes, type ComponentType, h } from "preact";
import "./lazy.css";
import { says } from "../lib/format.ts";
import { PageWaiting } from "../ui/PageWaiting.tsx";

export type Lazy<P> = ComponentType<P> & {
  load(): Promise<void>;
  // the shape drawn until the code lands, named for the route table's
  // tests, since a chunk another test loaded draws the view at once
  waiting: ComponentType<P>;
};

// the generic page while a view's code loads
export function PageCodeWaiting() {
  return h(PageWaiting, { label: "Loading the page" });
}

export function lazy<P>(
  loader: () => Promise<ComponentType<P>>,
  // the view's own shape while its code loads, for a page whose shape
  // is not a list's
  waiting: ComponentType<P> = PageCodeWaiting,
): Lazy<P> {
  const ready = signal<ComponentType<P> | null>(null);
  const failure = signal<string | null>(null);
  let pending: Promise<void> | null = null;
  const load = () => {
    if (pending === null) {
      failure.value = null;
      pending = loader().then(
        (component) => {
          ready.value = component;
        },
        (err) => {
          pending = null;
          failure.value = says(err);
        },
      );
    }
    return pending;
  };
  const Lazy = ((props: P) => {
    const View = ready.value;
    if (View !== null) return h(View, props as Attributes & P);
    if (failure.value !== null) {
      return h("div", { class: "lazy-fail" }, [
        h("p", { class: "error" }, failure.value),
        h(
          "button",
          { type: "button", class: "btn", onClick: () => void load() },
          "Try again",
        ),
      ]);
    }
    void load();
    return h(waiting, props as Attributes & P);
  }) as Lazy<P>;
  Lazy.load = load;
  Lazy.waiting = waiting;
  return Lazy;
}
