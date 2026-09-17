import type { measureVisual } from "./visual-height.ts";
import type {
  cleanVisual,
  inertVisual,
  VisualScript,
  visualAttributeRule,
  visualElementRule,
  visualScript,
} from "./visual-inert.ts";
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
  let paintFrame = 0;
  let heightFrame = 0;
  let pending = "";
  let lastHeight = -1;
  let errors = 0;
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
    heightFrame = requestAnimationFrame(() => {
      heightFrame = 0;
      const measured = helpers.measure(root);
      if (Number.isFinite(measured) && measured !== lastHeight) {
        lastHeight = measured;
        post({ type: "height", height: measured });
      }
    });
  };
  const paint = (html: string, final: boolean): VisualScript[] => {
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
    cancelAnimationFrame(paintFrame);
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
      window.dispatchEvent(new Event("visualtheme"));
      height();
    } else if (state === "painting") {
      if (message.type === "final") {
        void finalize(message.html);
      } else {
        pending = message.html;
        if (!paintFrame) {
          paintFrame = requestAnimationFrame(() => {
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
  new ResizeObserver(height).observe(root);
  document.addEventListener("load", height, true);
  window.addEventListener("resize", height);
  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(paintFrame);
    cancelAnimationFrame(heightFrame);
    port?.close();
    port = null;
  });
}
