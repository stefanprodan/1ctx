export function measureVisual(root: HTMLElement): number {
  const properties = [
    "height",
    "min-height",
    "max-height",
    "block-size",
    "min-block-size",
    "max-block-size",
  ];
  const restore: Array<{
    style: CSSStyleDeclaration;
    property: string;
    value: string;
    priority: string;
  }> = [];
  const changed = new Map<CSSStyleDeclaration, Set<string>>();
  const neutralize = (element: Element, property: string) => {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
      return;
    }
    const style = element.style;
    let set = changed.get(style);
    if (!set) {
      set = new Set();
      changed.set(style, set);
    }
    if (set.has(property)) return;
    set.add(property);
    restore.push({
      style,
      property,
      value: style.getPropertyValue(property),
      priority: style.getPropertyPriority(property),
    });
    const value = property.startsWith("min-")
      ? "0px"
      : property.startsWith("max-")
        ? "none"
        : "auto";
    style.setProperty(property, value, "important");
  };
  const viewportValue = (
    value: string,
    element: Element,
    depth = 0,
  ): boolean => {
    if (/\d(?:[sld]?v[hb]|vmin|vmax)\b/i.test(value)) return true;
    if (depth >= 8 || !value.includes("var(")) return false;
    const computed = getComputedStyle(element);
    return Array.from(value.matchAll(/var\(\s*(--[\w-]+)/g)).some((match) =>
      viewportValue(computed.getPropertyValue(match[1]), element, depth + 1),
    );
  };
  const inspect = (style: CSSStyleDeclaration, elements: Element[]) => {
    for (const property of properties) {
      const value = style.getPropertyValue(property);
      if (!value) continue;
      for (const element of elements) {
        if (viewportValue(value, element)) neutralize(element, property);
      }
    }
  };
  const rules = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSStyleRule) {
        try {
          inspect(
            rule.style,
            Array.from(document.querySelectorAll(rule.selectorText)),
          );
        } catch {
          // A library's unsupported selector cannot stop a height report.
        }
      } else if ("cssRules" in rule) {
        rules((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        rules(sheet.cssRules);
      } catch {
        // An opaque stylesheet cannot be inspected.
      }
    }
    for (const element of document.querySelectorAll<HTMLElement>("[style]")) {
      inspect(element.style, [element]);
    }
    // Document heights include the frame's previous viewport and feed it back.
    for (const element of [document.documentElement, document.body, root]) {
      for (const property of properties) neutralize(element, property);
    }
    const box = root.getBoundingClientRect();
    let height = Math.max(box.height, root.scrollHeight);
    for (const child of root.querySelectorAll("*")) {
      height = Math.max(height, child.getBoundingClientRect().bottom - box.top);
    }
    return Number.isFinite(height) ? Math.max(0, Math.ceil(height)) : 0;
  } finally {
    for (const { style, property, value, priority } of restore.reverse()) {
      if (value) style.setProperty(property, value, priority);
      else style.removeProperty(property);
    }
  }
}
