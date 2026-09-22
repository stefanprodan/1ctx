import type { measureVisual } from "./visual-height.ts";
import type {
  cleanVisual,
  inertVisual,
  VisualScript,
  visualAttributeRule,
  visualElementRule,
  visualScript,
} from "./visual-inert.ts";
import type { visualContrast, visualSchemeQuery } from "./visual-scheme.ts";
import type { visualThemeValues } from "./visual-theme.ts";

export type VisualMessage =
  | { type: "paint" | "final"; html: string }
  | {
      type: "theme";
      scheme: "light" | "dark";
      values: Record<string, string>;
    };

export function visualConnect(
  value: unknown,
  fromParent: boolean,
  portCount: number,
): boolean {
  return (
    fromParent &&
    portCount === 1 &&
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    "type" in value &&
    value.type === "connect"
  );
}

export function visualMessage(value: unknown): value is VisualMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("type" in value)) return false;
  const keys = Object.keys(value);
  if (value.type === "paint" || value.type === "final") {
    return (
      keys.length === 2 &&
      "html" in value &&
      typeof value.html === "string" &&
      value.html.length <= 512 * 1024 &&
      new TextEncoder().encode(value.html).byteLength <= 512 * 1024
    );
  }
  if (
    value.type !== "theme" ||
    keys.length !== 3 ||
    !("scheme" in value) ||
    (value.scheme !== "light" && value.scheme !== "dark") ||
    !("values" in value) ||
    !value.values ||
    typeof value.values !== "object" ||
    Array.isArray(value.values)
  ) {
    return false;
  }
  const entries = Object.entries(value.values);
  return (
    entries.length <= 16 &&
    entries.every(
      ([key, entry]) =>
        /^--(fg|dim|faint|card|inset|page|line|line-strong|radius|radius-card|sans|serif|mono)$/.test(
          key,
        ) &&
        typeof entry === "string" &&
        entry.length <= 256 &&
        !Array.from(entry).some(
          (char) => char < " " || char === "<" || char === ">",
        ),
    )
  );
}

type PainterHelpers = {
  clean: typeof cleanVisual;
  inert: typeof inertVisual;
  element: typeof visualElementRule;
  attribute: typeof visualAttributeRule;
  script: typeof visualScript;
  connect: typeof visualConnect;
  message: typeof visualMessage;
  theme: typeof visualThemeValues;
  measure: typeof measureVisual;
  query: typeof visualSchemeQuery;
  contrast: typeof visualContrast;
};
type Morpher = {
  morph(
    root: Element,
    content: DocumentFragment,
    options: {
      morphStyle: "innerHTML";
      callbacks: { afterNodeAdded(node: Node): void };
    },
  ): unknown;
};

export function bootVisual(helpers: PainterHelpers, morph: Morpher): void {
  const root = document.getElementById("visual-root")!;
  let port: MessagePort | null = null;
  let state: "painting" | "finalizing" | "finalized" = "painting";
  // timers, not animation frames: Chrome pauses frames in a cross-origin
  // iframe off screen, so a visual below the fold never reported its height
  let paintFrame: ReturnType<typeof setTimeout> | 0 = 0;
  let heightFrame: ReturnType<typeof setTimeout> | 0 = 0;
  let pending = "";
  let lastHeight = -1;
  let errors = 0;
  let scheme: "light" | "dark" | null = null;
  let page = false;
  const queries = new WeakMap<MediaList, string>();
  const post = (message: object) => port?.postMessage(message);
  const report = (message: string) => {
    if (errors++ < 8) {
      post({
        type: "error",
        message: message.replace(/[\r\n]+/g, " ").slice(0, 240),
      });
    }
  };
  const height = () => {
    if (heightFrame || !port) return;
    heightFrame = setTimeout(() => {
      heightFrame = 0;
      const measured = helpers.measure(root);
      if (Number.isFinite(measured) && measured !== lastHeight) {
        lastHeight = measured;
        post({ type: "height", height: measured });
      }
    });
  };
  const adapt = () => {
    if (!scheme) return;
    const media = (list: MediaList | null | undefined) => {
      if (!list || !scheme) return;
      let text = queries.get(list);
      if (text === undefined) {
        if (!/prefers-color-scheme/i.test(list.mediaText)) return;
        text = list.mediaText;
        queries.set(list, text);
      }
      const next = helpers.query(text, scheme);
      if (list.mediaText !== next) list.mediaText = next;
    };
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule) media(rule.media);
        if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets ?? [])) {
      try {
        media(sheet.media);
        walk(sheet.cssRules);
      } catch {
        // A stylesheet from another host cannot be read or rewritten.
      }
    }
  };
  // A whole page brings its own backdrop and the space around it, which the
  // chat already draws. Both go only when the page's text still reads on
  // the chat's ground.
  const ground = () => {
    const html = document.documentElement;
    let bare = false;
    try {
      if (page) {
        // A canvas resolves any colour syntax the page or the theme used.
        const channels = (value: string) => {
          if (!value.trim()) return null;
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const context = canvas.getContext("2d");
          if (!context) return null;
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
          return a ? [r, g, b] : null;
        };
        const root = getComputedStyle(html);
        const body = getComputedStyle(document.body);
        const text = channels(body.color);
        const chat = channels(
          root.getPropertyValue("--color-background-primary"),
        );
        bare =
          root.backgroundImage === "none" &&
          body.backgroundImage === "none" &&
          !!text &&
          !!chat &&
          helpers.contrast(text, chat) >= 4.5;
      }
      html.toggleAttribute("data-visual-bare", bare);
    } catch {
      // Without computed styles the page keeps its own backdrop.
    }
  };
  const paint = (html: string, final: boolean): VisualScript[] => {
    page = /<(?:html|body)[\s>]/i.test(html);
    const template = document.createElement("template");
    template.innerHTML = helpers.clean(html);
    const scripts = helpers.inert(
      template.content,
      final,
      helpers.element,
      helpers.attribute,
      helpers.script,
    );
    morph.morph(root, template.content, {
      morphStyle: "innerHTML",
      callbacks: {
        afterNodeAdded(node) {
          if (node instanceof Element) node.classList.add("visual-enter");
        },
      },
    });
    adapt();
    ground();
    height();
    return scripts;
  };
  const execute = (item: VisualScript): Promise<void> => {
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.type = item.type;
      script.async = false;
      let timer = 0;
      let settled = false;
      const done = (error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        if (error) {
          script.remove();
          report(error);
        }
        height();
        resolve();
      };
      if (item.src !== null || item.type === "module") {
        script.onload = () => done();
        script.onerror = () => done("A visual script did not load.");
        if (item.type !== "module") {
          timer = window.setTimeout(
            () => done("A visual script took too long to load."),
            10_000,
          );
        }
      }
      if (item.src !== null) script.src = item.src;
      else script.textContent = item.text;
      try {
        document.body.append(script);
        if (item.src === null && item.type !== "module") done();
      } catch {
        done("A visual script could not run.");
      }
    });
  };
  const finalize = async (html: string) => {
    state = "finalizing";
    clearTimeout(paintFrame);
    paintFrame = 0;
    pending = "";
    try {
      const scripts = paint(html, true);
      for (const script of scripts) {
        if (script.type !== "module") await execute(script);
      }
      for (const script of scripts) {
        // Module evaluation may await forever without blocking another module.
        if (script.type === "module") void execute(script);
      }
    } catch {
      report("The visual could not be drawn.");
    } finally {
      state = "finalized";
      post({ type: "finalized" });
      height();
    }
  };
  const receive = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (!helpers.message(message)) return;
    if (message.type === "theme") {
      const element = document.documentElement;
      element.dataset.theme = message.scheme;
      for (const [name, value] of Object.entries(
        helpers.theme(message.values),
      )) {
        element.style.setProperty(name, value);
      }
      scheme = message.scheme;
      adapt();
      ground();
      window.dispatchEvent(new Event("visualtheme"));
      height();
    } else if (state === "painting") {
      if (message.type === "final") {
        void finalize(message.html);
      } else {
        pending = message.html;
        if (!paintFrame) {
          paintFrame = setTimeout(() => {
            paintFrame = 0;
            try {
              paint(pending, false);
            } catch {
              report("The visual could not be drawn.");
            }
          });
        }
      }
    }
  };
  const connect = (event: MessageEvent) => {
    if (
      port ||
      !helpers.connect(
        event.data,
        event.source === window.parent,
        event.ports.length,
      ) ||
      !(event.ports[0] instanceof MessagePort)
    ) {
      return;
    }
    port = event.ports[0];
    window.removeEventListener("message", connect);
    port.onmessage = receive;
    port.start();
    post({ type: "ready" });
    height();
  };
  window.addEventListener("message", connect);
  window.addEventListener("error", (event) => {
    event.preventDefault();
    report(event.message || "A visual script could not run.");
  });
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    report("A visual script could not finish.");
  });
  for (const name of ["click", "auxclick"]) {
    document.addEventListener(
      name,
      (event) => {
        if (
          event
            .composedPath()
            .some(
              (node) =>
                node instanceof Element &&
                (node.localName === "a" || node.localName === "area"),
            )
        ) {
          event.preventDefault();
        }
      },
      true,
    );
  }
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  if (typeof window.matchMedia === "function") {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      matchMedia(scheme ? helpers.query(query, scheme) : query);
  }
  if (typeof MutationObserver === "function") {
    new MutationObserver((records) => {
      const styled = records.some((record) =>
        Array.from(record.addedNodes).some(
          (node) => node.nodeName === "STYLE" || node.nodeName === "LINK",
        ),
      );
      if (styled) {
        adapt();
        ground();
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  new ResizeObserver(height).observe(root);
  document.addEventListener(
    "load",
    () => {
      adapt();
      ground();
      height();
    },
    true,
  );
  window.addEventListener("resize", height);
  window.addEventListener("pagehide", () => {
    clearTimeout(paintFrame);
    clearTimeout(heightFrame);
    port?.close();
    port = null;
  });
}
