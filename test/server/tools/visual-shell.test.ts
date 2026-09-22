import { expect, test } from "bun:test";
import { measureVisual } from "../../../src/server/tools/visual-height.ts";
import type {
  VisualAttribute,
  VisualElement,
  VisualScript,
  VisualTree,
} from "../../../src/server/tools/visual-inert.ts";
import { bootVisual } from "../../../src/server/tools/visual-painter.ts";
import {
  visualContrast,
  visualSchemeQuery,
} from "../../../src/server/tools/visual-scheme.ts";
import {
  cleanVisual,
  inertVisual,
  visualAttributeRule,
  visualConnect,
  visualCsp,
  visualDocument,
  visualElementRule,
  visualMessage,
  visualScript,
  visualShell,
} from "../../../src/server/tools/visual-shell.ts";
import { visualThemeValues } from "../../../src/server/tools/visual-theme.ts";
import fixture from "../../fixtures/tools/visual-inert.json";

type FixtureNode = {
  name: string;
  attributes?: Record<string, string | undefined>;
  text?: string;
  children?: FixtureNode[];
  content?: FixtureNode[];
};
function tree(nodes: FixtureNode[]): VisualTree {
  const root: { children: VisualElement[] } = { children: [] };
  root.children = nodes.map((node) => {
    const element: VisualElement = {
      localName: node.name,
      attributes: Object.entries(node.attributes ?? {}).flatMap(
        ([name, value]) => (value === undefined ? [] : [{ name, value }]),
      ),
      children: tree(node.children ?? []).children,
      content: node.content ? tree(node.content) : undefined,
      textContent: node.text ?? "",
      remove() {
        root.children.splice(root.children.indexOf(element), 1);
      },
      removeAttribute(name) {
        element.attributes = Array.from(element.attributes).filter(
          (attribute) => attribute.name !== name,
        );
      },
    };
    return element;
  });
  return root;
}
function flatten(root: VisualTree): VisualElement[] {
  return Array.from(root.children).flatMap((element) => [
    element,
    ...flatten(element.content ?? element),
  ]);
}
function sanitize(root: VisualTree, final: boolean) {
  return inertVisual(
    root,
    final,
    visualElementRule,
    visualAttributeRule,
    visualScript,
  );
}

test.each(fixture.clean)("cleans an incomplete fragment: $html", (entry) => {
  expect(cleanVisual(entry.html)).toBe(entry.expected);
});

test.each([false, true])(
  "takes every script out before morphing, final=%s",
  (final) => {
    const root = tree(fixture.elements);
    expect(sanitize(root, final)).toEqual([
      { type: "", src: null, text: "first()" },
      { type: "", src: "https://scripts.test/a.js", text: "" },
      { type: "", src: "https://scripts.test/svg.js", text: "" },
      { type: "module", src: "https://scripts.test/module.js", text: "" },
      { type: "", src: null, text: "nested()" },
      { type: "text/javascript", src: null, text: "last()" },
    ]);
    const elements = flatten(root);
    expect(
      elements.every(
        (element) => visualElementRule(element.localName) === "keep",
      ),
    ).toBe(true);
    const attributes = elements.flatMap((element) =>
      Array.from(element.attributes),
    );
    expect(attributes.some(({ name }) => name.startsWith("on"))).toBe(final);
    expect(attributes.some(({ value }) => /javascript:/i.test(value))).toBe(
      final,
    );
  },
);

test("walks deeply nested template contents without recursive calls", () => {
  const leaf = tree([{ name: "script", text: "deep()" }]);
  let root: VisualTree = leaf;
  for (let i = 0; i < 20_000; i++) {
    const element = tree([{ name: "template" }]).children[0];
    element.content = root;
    root = { children: [element] };
  }
  expect(sanitize(root, false)).toEqual([
    { type: "", src: null, text: "deep()" },
  ]);
  expect(leaf.children.length).toBe(0);
});

test("inert attributes handle decoded control characters and namespaced URLs", () => {
  const attributes: VisualAttribute[] = [
    { name: "onBegin", value: "run()" },
    { name: "HREF", value: " java\r\nscript:run()" },
    { name: "xlink:href", value: "\u0000JavaScript:run()" },
    { name: "action", value: "javascript:run()" },
    { name: "formaction", value: "javascript:run()" },
    { name: "src", value: "javascript:run()" },
  ];
  for (const { name, value } of attributes) {
    expect(visualAttributeRule(name, value, false)).toBe(false);
    expect(visualAttributeRule(name, value, true)).toBe(true);
  }
  expect(visualAttributeRule("href", "#local", false)).toBe(true);
  expect(visualAttributeRule("src", "data:image/png;base64,AA==", false)).toBe(
    true,
  );
  expect(visualScript([{ name: "src", value: "" }], null).src).toBe("");
});

test("only a single parent connect with one port has the right shape", () => {
  expect(visualConnect({ type: "connect" }, true, 1)).toBe(true);
  for (const value of [
    null,
    [],
    {},
    { type: "paint" },
    { type: "connect", extra: 1 },
  ]) {
    expect(visualConnect(value, true, 1)).toBe(false);
  }
  expect(visualConnect({ type: "connect" }, false, 1)).toBe(false);
  expect(visualConnect({ type: "connect" }, true, 0)).toBe(false);
  expect(visualConnect({ type: "connect" }, true, 2)).toBe(false);
});

test("port messages have bounded exact shapes and UTF-8 fragments", () => {
  expect(visualMessage({ type: "paint", html: "x".repeat(512 * 1024) })).toBe(
    true,
  );
  expect(
    visualMessage({ type: "final", html: "x".repeat(512 * 1024 + 1) }),
  ).toBe(false);
  expect(
    visualMessage({ type: "paint", html: "😀".repeat(128 * 1024 + 1) }),
  ).toBe(false);
  expect(
    visualMessage({
      type: "theme",
      scheme: "dark",
      values: { "--fg": "text" },
    }),
  ).toBe(true);
  for (const value of [
    null,
    [],
    { type: "connect" },
    { type: "paint", html: 1 },
    { type: "paint", html: "ok", extra: 1 },
    { type: "theme", scheme: "system", values: {} },
    { type: "theme", scheme: "light", values: { "--fg": "x".repeat(257) } },
    { type: "theme", scheme: "light", values: { "--fg": "</style>" } },
    { type: "theme", scheme: "light", values: { "--unknown": "value" } },
  ]) {
    expect(visualMessage(value)).toBe(false);
  }
});

test("the document embeds Idiomorph and browser-valid painter code", () => {
  const html = visualDocument();
  expect(html).toContain("var Idiomorph=function");
  expect(html).toContain('id="visual-root"');
  expect(html).not.toContain("<script src=");
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g));
  expect(scripts).toHaveLength(1);
  expect(() => new Function(scripts[0][1])).not.toThrow();
  expect(html).toContain("visualtheme");
});

test("the shell grants only the saved script, style and font hosts", async () => {
  const hosts = ["https://scripts.test", "https://styles.test"];
  const response = visualShell(hosts);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  const csp = response.headers.get("content-security-policy")!;
  expect(csp).toBe(visualCsp(hosts));
  for (const directive of [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' https://scripts.test https://styles.test",
    "style-src 'unsafe-inline' https://scripts.test https://styles.test",
    "font-src data: https://scripts.test https://styles.test",
    "img-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ]) {
    expect(csp.split("; ")).toContain(directive);
  }
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).not.toContain("allow-popups");
  expect(csp).not.toContain("webrtc");
  expect(await response.text()).toBe(visualDocument());
  expect(visualCsp([])).not.toContain("https:");
});

test("the shell ETag varies with hosts and answers conditional requests", async () => {
  const etag = visualShell([]).headers.get("etag")!;
  expect(visualShell([]).headers.get("etag")).toBe(etag);
  expect(visualShell(["https://scripts.test"]).headers.get("etag")).not.toBe(
    etag,
  );
  for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
    const request = new Request("https://app.test/api/visual", {
      headers: { "if-none-match": header },
    });
    const response = visualShell([], request);
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-security-policy")).toBe(visualCsp([]));
  }
  for (const header of ['"other"', "", "unquoted"]) {
    const request = new Request("https://app.test/api/visual", {
      headers: { "if-none-match": header },
    });
    expect(visualShell([], request).status).toBe(200);
  }
  const request = new Request("https://app.test/api/visual", {
    headers: { "if-none-match": etag },
  });
  const changed = visualShell(["https://scripts.test"], request);
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(etag);
  expect(await changed.text()).toBe(visualDocument());
  expect(
    visualShell([], new Request("https://app.test/api/visual")).status,
  ).toBe(200);
});

function painter(scripts: VisualScript[]) {
  const events = new Map<string, (event: Record<string, unknown>) => void>();
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const appended: Array<{
    type: string;
    src?: string;
    textContent?: string;
    onload?: (() => void) | null;
    onerror?: (() => void) | null;
  }> = [];
  const morphs: boolean[] = [];
  const styles: Record<string, string> = {};
  const flags = new Set<string>();
  let themeEvents = 0;
  let next = 1;
  let final = false;
  class Port {
    messages: Array<{ type: string; height?: number; message?: string }> = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    start() {}
    close() {}
    postMessage(message: (typeof this.messages)[number]) {
      this.messages.push(message);
    }
    send(data: unknown) {
      this.onmessage?.({ data });
    }
  }
  class Element {}
  const root = new Element();
  const window = {
    parent: {},
    addEventListener(
      name: string,
      handler: (event: Record<string, unknown>) => void,
    ) {
      events.set(name, handler);
    },
    removeEventListener(name: string) {
      events.delete(name);
    },
    dispatchEvent() {
      themeEvents++;
    },
    setTimeout(callback: () => void) {
      const id = next++;
      timers.set(id, callback);
      return id;
    },
  };
  const document = {
    getElementById: () => root,
    documentElement: {
      dataset: {},
      toggleAttribute(name: string, on: boolean) {
        if (on) flags.add(name);
        else flags.delete(name);
      },
      style: {
        setProperty(name: string, value: string) {
          styles[name] = value;
        },
      },
    },
    createElement: () => ({ content: tree([]), remove() {} }),
    addEventListener() {},
    body: {
      append: (script: (typeof appended)[number]) => appended.push(script),
    },
  };
  const start = new Function(
    "document",
    "window",
    "setTimeout",
    "ResizeObserver",
    "MessagePort",
    "Element",
    "clearTimeout",
    `return (${bootVisual.toString()})`,
  ) as (...globals: unknown[]) => typeof bootVisual;
  const boot = start(
    document,
    window,
    (callback: () => void) => {
      const id = next++;
      frames.set(id, callback);
      return id;
    },
    class {
      observe() {}
    },
    Port,
    Element,
    (id: number) => {
      frames.delete(id);
      timers.delete(id);
    },
  );
  boot(
    {
      clean: cleanVisual,
      inert: (_root, isFinal) => {
        final = isFinal;
        return scripts;
      },
      element: visualElementRule,
      attribute: visualAttributeRule,
      script: visualScript,
      connect: visualConnect,
      message: visualMessage,
      theme: visualThemeValues,
      measure: () => 123,
      query: visualSchemeQuery,
      contrast: visualContrast,
    },
    { morph: () => morphs.push(final) },
  );
  const port = new Port();
  const connect = events.get("message")!;
  return {
    port,
    appended,
    morphs,
    styles,
    flags,
    timers,
    events,
    get themeEvents() {
      return themeEvents;
    },
    connect: (fromParent = true) =>
      connect({
        data: { type: "connect" },
        source: fromParent ? window.parent : {},
        ports: [port],
      }),
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

async function tick() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("a port binds once, coalesces previews and cancels them for final", async () => {
  const app = painter([{ type: "", src: null, text: "once()" }]);
  app.connect(false);
  expect(app.port.messages).toEqual([]);
  app.connect();
  app.connect();
  expect(app.port.messages).toEqual([{ type: "ready" }]);
  app.port.send({ type: "paint", html: "one" });
  app.port.send({ type: "paint", html: "two" });
  app.frame();
  expect(app.morphs).toEqual([false]);
  expect(app.appended).toHaveLength(0);
  expect(app.port.messages).toContainEqual({ type: "height", height: 123 });
  app.port.send({ type: "paint", html: "queued" });
  app.port.send({ type: "final", html: "final" });
  app.port.send({ type: "final", html: "again" });
  app.port.send({ type: "paint", html: "late" });
  app.frame();
  await tick();
  expect(app.morphs).toEqual([false, true]);
  expect(
    app.port.messages.filter((message) => message.type === "finalized"),
  ).toEqual([{ type: "finalized" }]);
  expect(app.appended).toHaveLength(1);
  app.port.send({ type: "theme", scheme: "dark", values: { "--fg": "text" } });
  expect(app.styles["--color-text-primary"]).toBe("text");
  expect(app.themeEvents).toBe(1);
  expect(app.appended).toHaveLength(1);
});

test("final replays classic scripts before modules and continues after loads fail", async () => {
  const app = painter([
    { type: "module", src: null, text: "await forever()" },
    { type: "", src: null, text: "first()" },
    { type: "", src: "https://scripts.test/one.js", text: "" },
    { type: "", src: "https://scripts.test/two.js", text: "" },
    { type: "", src: "https://scripts.test/three.js", text: "" },
    { type: "", src: null, text: "last()" },
    { type: "module", src: null, text: "secondModule()" },
  ]);
  app.connect();
  app.port.send({ type: "final", html: "whole" });
  await tick();
  expect(app.appended).toHaveLength(2);
  app.appended[1].onload?.();
  await tick();
  expect(app.appended).toHaveLength(3);
  app.appended[2].onerror?.();
  await tick();
  expect(app.appended).toHaveLength(4);
  const timeout = [...app.timers.values()][0];
  timeout();
  await tick();
  expect(
    app.appended.map((script) => script.src ?? script.textContent),
  ).toEqual([
    "first()",
    "https://scripts.test/one.js",
    "https://scripts.test/two.js",
    "https://scripts.test/three.js",
    "last()",
    "await forever()",
    "secondModule()",
  ]);
  expect(
    app.port.messages.filter((message) => message.type === "error"),
  ).toHaveLength(2);
  app.events.get("error")?.({
    message: "A script threw\nits error",
    preventDefault() {},
  });
  expect(app.port.messages.at(-1)).toEqual({
    type: "error",
    message: "A script threw its error",
  });
});

test("height measurement neutralizes authored viewport heights and restores styles", () => {
  const makeStyle = (entries: Record<string, string>) => ({
    getPropertyValue: (name: string) => entries[name] ?? "",
    getPropertyPriority: () => "",
    setProperty: (name: string, value: string) => {
      entries[name] = value;
    },
    removeProperty: (name: string) => {
      delete entries[name];
    },
  });
  class Element {
    style = makeStyle({});
    getBoundingClientRect() {
      return { height: 80, bottom: 80, top: 0 };
    }
  }
  const child = new Element();
  child.style = makeStyle({ height: "100dvh", "--size": "100vh" });
  child.getBoundingClientRect = () => ({
    height: child.style.getPropertyValue("height") === "auto" ? 80 : 900,
    bottom: child.style.getPropertyValue("height") === "auto" ? 80 : 900,
    top: 0,
  });
  const root = Object.assign(new Element(), {
    scrollHeight: 80,
    querySelectorAll: () => [child],
  });
  const document = {
    documentElement: new Element(),
    body: new Element(),
    styleSheets: [],
    querySelectorAll: () => [child],
  };
  const run = new Function(
    "document",
    "HTMLElement",
    "SVGElement",
    "CSSStyleRule",
    "getComputedStyle",
    `return (${measureVisual.toString()})`,
  )(
    document,
    Element,
    Element,
    class {},
    (element: Element) => element.style,
  ) as typeof measureVisual;
  expect(run(root as unknown as HTMLElement)).toBe(80);
  expect(child.style.getPropertyValue("height")).toBe("100dvh");
  expect(root.style.getPropertyValue("height")).toBe("");
});

test("height measurement counts the body's padding and margins", () => {
  const style = (entries: Record<string, string>) => ({
    getPropertyValue: (name: string) => entries[name] ?? "",
    getPropertyPriority: () => "",
    setProperty: () => {},
    removeProperty: () => {},
  });
  class Element {
    style = style({});
    constructor(
      private box: { top: number; bottom: number },
      entries: Record<string, string> = {},
    ) {
      this.style = style(entries);
    }
    getBoundingClientRect() {
      return { ...this.box, height: this.box.bottom - this.box.top };
    }
  }
  // A body padded 14px with an 8px margin on the page: the root sits 22px
  // down and the page ends 22px below it.
  const html = new Element({ top: 0, bottom: 124 }, { "margin-bottom": "0" });
  const root = Object.assign(new Element({ top: 22, bottom: 102 }), {
    scrollHeight: 80,
    querySelectorAll: () => [],
  });
  const document = {
    documentElement: html,
    body: new Element({ top: 8, bottom: 116 }),
    styleSheets: [],
    querySelectorAll: () => [],
  };
  const run = new Function(
    "document",
    "HTMLElement",
    "SVGElement",
    "CSSStyleRule",
    "getComputedStyle",
    `return (${measureVisual.toString()})`,
  )(
    document,
    Element,
    Element,
    class {},
    (element: Element) => element.style,
  ) as typeof measureVisual;
  expect(run(root as unknown as HTMLElement)).toBe(124);
});

test("a page's colour scheme queries follow the chat's theme", () => {
  expect(visualSchemeQuery("(prefers-color-scheme: light)", "light")).toBe(
    "(min-width: 0px)",
  );
  expect(visualSchemeQuery("(prefers-color-scheme: light)", "dark")).toBe(
    "(max-width: 0px)",
  );
  expect(
    visualSchemeQuery("screen and (PREFERS-COLOR-SCHEME : Dark)", "dark"),
  ).toBe("screen and (min-width: 0px)");
  expect(
    visualSchemeQuery("not all and (prefers-color-scheme: dark)", "light"),
  ).toBe("not all and (max-width: 0px)");
  expect(visualSchemeQuery("(prefers-color-scheme)", "light")).toBe(
    "(min-width: 0px)",
  );
  expect(visualSchemeQuery("(max-width: 600px)", "dark")).toBe(
    "(max-width: 600px)",
  );
});

test("contrast is the WCAG ratio in either order", () => {
  expect(visualContrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
  expect(visualContrast([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
  expect(visualContrast([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 2);
  expect(visualContrast([26, 26, 24], [26, 26, 24])).toBe(1);
});

test("a fragment keeps the frame's ground untouched", async () => {
  const app = painter([]);
  app.connect();
  app.port.send({ type: "final", html: "<div>fragment</div>" });
  await tick();
  expect(app.flags.has("data-visual-bare")).toBe(false);
});
