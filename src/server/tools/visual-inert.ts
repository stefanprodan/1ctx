export type VisualScript = { type: string; src: string | null; text: string };
export type VisualAttribute = { name: string; value: string };
export type VisualTree = { children: ArrayLike<VisualElement> };
export type VisualElement = VisualTree & {
  localName: string;
  attributes: ArrayLike<VisualAttribute>;
  content?: VisualTree;
  textContent: string | null;
  remove(): void;
  removeAttribute(name: string): void;
};

export function cleanVisual(html: string): string {
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end < 0) return html.slice(0, start);
      cursor = end + 3;
      continue;
    }
    if (start === html.length - 1) return html.slice(0, start);
    if (!/[a-z!/?]/i.test(html[start + 1])) {
      cursor = start + 1;
      continue;
    }
    let quote = "";
    let end = start + 1;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end === html.length) return html.slice(0, start);
    const tag = /^<([a-z][a-z0-9:-]*)(?=[\s/>])/i
      .exec(html.slice(start, end + 1))?.[1]
      ?.toLowerCase();
    cursor = end + 1;
    if (
      tag &&
      /^(style|script|textarea|title|xmp|iframe|noembed|noframes)$/.test(tag)
    ) {
      const close = new RegExp(`</${tag}(?=[\\s/>])`, "gi");
      close.lastIndex = cursor;
      const match = close.exec(html);
      if (!match) return tag === "style" ? html.slice(0, start) : html;
      const closeEnd = html.indexOf(">", match.index + match[0].length);
      if (closeEnd < 0) {
        return tag === "style" ? html.slice(0, start) : html;
      }
      cursor = closeEnd + 1;
    }
  }
  return html.replace(/&(?:#(?:x[0-9a-f]*|\d*)?|[a-z][a-z0-9]*)?$/i, "");
}

export function visualElementRule(name: string): "script" | "remove" | "keep" {
  name = name.toLowerCase();
  if (name === "script") return "script";
  return /^(meta|base|iframe|frame|frameset|object|embed|portal|form)$/.test(
    name,
  )
    ? "remove"
    : "keep";
}

export function visualAttributeRule(
  name: string,
  value: string,
  final: boolean,
): boolean {
  if (final) return true;
  name = name.toLowerCase();
  if (name.startsWith("on")) return false;
  if (!/^(href|src|xlink:href|action|formaction)$/.test(name)) return true;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII controls can disguise a URL scheme.
  const compact = value.replace(/[\u0000-\u0020\u007f]/g, "");
  return !/^javascript:/i.test(compact);
}

export function visualScript(
  attributes: ArrayLike<VisualAttribute>,
  text: string | null,
): VisualScript {
  const values = new Map(
    Array.from(attributes, ({ name, value }) => [name.toLowerCase(), value]),
  );
  return {
    type: (values.get("type") ?? "").trim().toLowerCase(),
    src:
      values.get("src") ??
      values.get("href") ??
      values.get("xlink:href") ??
      null,
    text: text ?? "",
  };
}

export function inertVisual(
  root: VisualTree,
  final: boolean,
  elementRule: typeof visualElementRule,
  attributeRule: typeof visualAttributeRule,
  takeScript: typeof visualScript,
): VisualScript[] {
  const scripts: VisualScript[] = [];
  // An explicit stack also visits template contents without a depth limit.
  const pending = Array.from(root.children).reverse();
  while (pending.length) {
    const element = pending.pop()!;
    const rule = elementRule(element.localName);
    if (rule === "script") {
      scripts.push(takeScript(element.attributes, element.textContent));
      element.remove();
      continue;
    }
    if (rule === "remove") {
      element.remove();
    } else {
      for (const { name, value } of Array.from(element.attributes)) {
        if (!attributeRule(name, value, final)) element.removeAttribute(name);
      }
    }
    const children =
      element.localName.toLowerCase() === "template" && element.content
        ? element.content.children
        : element.children;
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  return scripts;
}
