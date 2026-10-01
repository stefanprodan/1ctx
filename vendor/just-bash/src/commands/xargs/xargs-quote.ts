/**
 * (1ctx xargs-gnu) An argument quoted for -t as GNU xargs prints it: bare when the
 * shell would read it as it is, in double quotes when a single quote is
 * the only trouble, else in single quotes, a control character written
 * as $'\n' outside them.
 */

const NAMED: Record<string, string> = {
  "\x07": "a",
  "\b": "b",
  "\f": "f",
  "\n": "n",
  "\r": "r",
  "\t": "t",
  "\v": "v",
};

function isControl(c: string): boolean {
  const code = c.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

function controlEscape(c: string): string {
  const named = NAMED[c];
  if (named) return `$'\\${named}'`;
  return `$'\\${c.charCodeAt(0).toString(8).padStart(3, "0")}'`;
}

export function quoteForTrace(arg: string): string {
  if (arg === "") return "''";
  const special = /[ '"\\$`*?^!;&|<>()[=]/.test(arg);
  const leading = arg[0] === "~" || arg[0] === "#";
  let control = false;
  for (const c of arg) {
    if (isControl(c)) {
      control = true;
      break;
    }
  }
  if (!special && !leading && !control && arg !== "{") return arg;
  if (!control && arg.includes("'") && !/["$`\\!]/.test(arg)) {
    return `"${arg}"`;
  }
  let out = "'";
  let open = true;
  for (const c of arg) {
    if (isControl(c)) {
      if (open) out += "'";
      out += controlEscape(c);
      open = false;
    } else if (c === "'") {
      out += open ? "'\\''" : "\\'";
    } else {
      if (!open) out += "'";
      out += c;
      open = true;
    }
  }
  if (open) out += "'";
  return out;
}
