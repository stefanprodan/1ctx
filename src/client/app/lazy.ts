// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A view loaded on first use, so the route table names every view
// without putting every view in the first bundle. The loader runs once
// per attempt; until it answers the component renders nothing, then
// re-renders through its signal. A loader that fails renders the reason
// and a retry, and the next render or load() tries again.

import { signal } from "@preact/signals";
import { type Attributes, type ComponentType, h } from "preact";
import "./lazy.css";
import { says } from "../lib/format.ts";

export type Lazy<P> = ComponentType<P> & { load(): Promise<void> };

export function lazy<P>(loader: () => Promise<ComponentType<P>>): Lazy<P> {
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
    return null;
  }) as Lazy<P>;
  Lazy.load = load;
  return Lazy;
}
