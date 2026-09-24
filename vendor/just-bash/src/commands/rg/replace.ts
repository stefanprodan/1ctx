/**
 * (1ctx) ripgrep's replacement syntax: `$N`, `${N}`, `$name`, `${name}`
 * and `$$`. A bare name runs as far as letters, digits and `_` go, so
 * `$1x` is the group named `1x`; a group that did not take part, or does
 * not exist, is empty; a `$` that starts no reference stays as it is.
 */

type Part = string | number | { name: string };

function reference(name: string): Part {
  return /^\d+$/.test(name) ? Number(name) : { name };
}

export function compileReplacement(
  template: string,
): (match: RegExpExecArray) => string {
  const parts: Part[] = [];
  let literal = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== "$") {
      literal += ch;
      i++;
      continue;
    }
    if (template[i + 1] === "$") {
      literal += "$";
      i += 2;
      continue;
    }
    let name = "";
    let end = i + 1;
    if (template[i + 1] === "{") {
      const close = template.indexOf("}", i + 2);
      if (close > i + 2) {
        name = template.slice(i + 2, close);
        end = close + 1;
      }
    } else {
      const run = /^[A-Za-z0-9_]+/.exec(template.slice(i + 1));
      if (run) {
        name = run[0];
        end = i + 1 + name.length;
      }
    }
    if (name === "") {
      literal += "$";
      i++;
      continue;
    }
    if (literal !== "") parts.push(literal);
    literal = "";
    parts.push(reference(name));
    i = end;
  }
  if (literal !== "") parts.push(literal);
  return (match) => {
    let out = "";
    for (const part of parts) {
      if (typeof part === "string") out += part;
      else if (typeof part === "number") out += match[part] ?? "";
      else out += match.groups?.[part.name] ?? "";
    }
    return out;
  };
}
