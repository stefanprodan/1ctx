// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A component mounted for real, its hooks and effects run, over a
// document of plain objects: enough for Preact to render into, never a
// browser. A test that follows a view across renders (a wait that ends,
// a timer that fires) mounts it here and reads its markup as a string,
// as render-to-string's tests do. It sets globalThis.document and the
// few layout globals effects reach for, so the tests that mount are
// test.serial.

import { render, type VNode } from "preact";
import { act } from "preact/test-utils";
import type { DayClock } from "../../src/client/lib/now.ts";

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attributes = new Map<string, string>();
  style: Record<string, string> & {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  innerHTML = "";

  constructor(
    readonly nodeName: string,
    public data = "",
  ) {
    const style: Record<string, string> = {};
    this.style = Object.assign(style, {
      setProperty: (name: string, value: string) => {
        style[name] = value;
      },
      removeProperty: (name: string) => {
        delete style[name];
      },
    });
  }

  get localName(): string {
    return this.nodeName;
  }
  get nodeType(): number {
    return this.nodeName === "#text" ? 3 : 1;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    const at = before === null ? -1 : this.childNodes.indexOf(before);
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return child;
  }
  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }
  removeChild(child: FakeNode): FakeNode {
    this.childNodes = this.childNodes.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  // no layout: nothing is found by a selector, nothing measures
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  addEventListener(): void {}
  removeEventListener(): void {}

  // the markup, attributes in the order they were set
  get outerHTML(): string {
    if (this.nodeName === "#text") return this.data;
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${v}"`).join("");
    const inner =
      this.innerHTML || this.childNodes.map((c) => c.outerHTML).join("");
    return `<${this.nodeName}${attrs}>${inner}</${this.nodeName}>`;
  }
}

const fakeDocument = {
  createElement: (name: string) => new FakeNode(name),
  createElementNS: (_ns: string, name: string) => new FakeNode(name),
  createTextNode: (data: string) => new FakeNode("#text", data),
};

export type Mounted = {
  // the markup drawn now
  html(): string;
  // draws the component again with new props, its hooks' state kept
  update(node: VNode): Promise<void>;
  unmount(): Promise<void>;
};

// what a view's effects reach for beyond the document, none of which
// measures or schedules anything here
const LAYOUTLESS: Record<string, unknown> = {
  document: fakeDocument,
  getComputedStyle: () => ({ overflowY: "visible" }),
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
};

export async function mount(node: VNode): Promise<Mounted> {
  const g = globalThis as Record<string, unknown>;
  const held = Object.fromEntries(
    Object.keys(LAYOUTLESS).map((key) => [key, g[key]]),
  );
  Object.assign(g, LAYOUTLESS);
  const root = new FakeNode("div");
  const into = root as unknown as HTMLElement;
  await act(() => render(node, into));
  return {
    html: () => root.childNodes.map((c) => c.outerHTML).join(""),
    update: (next) => act(() => render(next, into)),
    async unmount() {
      await act(() => render(null, into));
      for (const [key, value] of Object.entries(held)) {
        if (value === undefined) delete g[key];
        else g[key] = value;
      }
    },
  };
}

// a clock moved by hand: advance() fires the timers due by then, inside
// act so the renders they ask for are drawn
export function fakeClock(start = 1_000_000): DayClock & {
  advance(ms: number): Promise<void>;
  pending(): number;
} {
  let now = start;
  let timers: { due: number; fire: () => void }[] = [];
  return {
    now: () => now,
    after(ms, fire) {
      const timer = { due: now + ms, fire };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    pending: () => timers.length,
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = timers
          .filter((t) => t.due <= until)
          .sort((a, b) => a.due - b.due)[0];
        if (next === undefined) break;
        timers = timers.filter((t) => t !== next);
        now = next.due;
        await act(() => next.fire());
      }
      now = until;
    },
  };
}
