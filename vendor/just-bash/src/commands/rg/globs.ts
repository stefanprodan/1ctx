/**
 * (1ctx) ripgrep's globs: one compiler for -g, --iglob, the ignore files
 * and --type-add, with the rules of the ignore crate's gitignore matcher.
 */

import { createUserRegex, type RegexLike } from "../../regex/index.js";

export class GlobError extends Error {}

const META = /[.*+?^${}()|[\]\\/]/g;

function escape(text: string): string {
  return text.replace(META, "\\$&");
}

/** A bracket expression from `[` at `start`: its regex and where it ends. */
function bracket(
  glob: string,
  start: number,
  lenient: boolean,
): { source: string; end: number } {
  let i = start + 1;
  let negated = false;
  if (glob[i] === "!" || glob[i] === "^") {
    negated = true;
    i++;
  }
  let body = "";
  let first = true;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "]" && !first) {
      return { source: `[${negated ? "^" : ""}${body}]`, end: i + 1 };
    }
    if (ch === "\\" && i + 1 < glob.length) {
      body += `\\${glob[i + 1]}`;
      i += 2;
    } else if (ch === "-" && !first && glob[i + 1] !== "]") {
      body += "-";
      i++;
    } else {
      body += /[\\\]^[-]/.test(ch) ? `\\${ch}` : ch;
      i++;
    }
    first = false;
  }
  // an ignore file reads an unclosed [ as itself, as ripgrep 14 does
  if (lenient) return { source: "\\[", end: start + 1 };
  throw new GlobError("unclosed character class; missing ']'");
}

/** The regex source of a glob, matched against a whole relative path. */
export function globSource(glob: string, lenient = false): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      let stars = 1;
      while (glob[i + stars] === "*") stars++;
      const prev = glob[i - 1];
      const next = glob[i + stars];
      // an alternative inside braces is a glob of its own
      const atStart =
        i === 0 || prev === "/" || (depth > 0 && (prev === "{" || prev === ","));
      const atEnd =
        next === undefined ||
        next === "/" ||
        (depth > 0 && (next === "," || next === "}"));
      if (stars >= 2 && atStart && atEnd) {
        if (next !== "/") {
          // a trailing ** is anything below, a whole ** anything at all
          out = i === 0 ? ".*" : `${out}.*`;
          i += stars;
        } else {
          // **/ is zero or more directories
          out += "(?:[^/]*/)*";
          i += stars + 1;
        }
        continue;
      }
      out += "[^/]*";
      i += stars;
    } else if (ch === "?") {
      out += "[^/]";
      i++;
    } else if (ch === "[") {
      const b = bracket(glob, i, lenient);
      out += b.source;
      i = b.end;
    } else if (ch === "{") {
      depth++;
      out += "(?:";
      i++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      out += ")";
      i++;
    } else if (ch === "," && depth > 0) {
      out += "|";
      i++;
    } else if (ch === "\\" && i + 1 < glob.length) {
      out += escape(glob[i + 1]);
      i += 2;
    } else {
      out += escape(ch);
      i++;
    }
  }
  if (depth > 0) {
    throw new GlobError(
      "unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)",
    );
  }
  return out;
}

export interface IgnoreGlob {
  regex: RegexLike;
  /** `!` in an ignore file; in an override, a glob that selects */
  whitelist: boolean;
  dirOnly: boolean;
}

/**
 * One line of an ignore file, or one -g glob before its inversion: a
 * glob without a slash matches a name at any depth, a leading slash
 * anchors it, a trailing slash matches directories only.
 */
export function compileIgnoreGlob(
  line: string,
  caseInsensitive = false,
  lenient = false,
): IgnoreGlob {
  let text = line;
  let whitelist = false;
  let absolute = false;
  if (text.startsWith("\\!") || text.startsWith("\\#")) {
    text = text.slice(1);
  } else {
    if (text.startsWith("!")) {
      whitelist = true;
      text = text.slice(1);
    }
    if (text.startsWith("/")) {
      absolute = true;
      text = text.slice(1);
    }
  }
  let dirOnly = false;
  if (text.endsWith("/") && text.length > 0) {
    dirOnly = true;
    text = text.slice(0, -1);
  }
  if (!absolute && !text.includes("/") && !text.startsWith("**/")) {
    text = `**/${text}`;
  }
  if (text.endsWith("/**")) text = `${text}/*`;
  const regex = createUserRegex(
    `^${globSource(text, lenient)}$`,
    caseInsensitive ? "i" : "",
  );
  return { regex, whitelist, dirOnly };
}

export type GlobMatch = "ignore" | "whitelist" | "none";

/** The last glob that matches decides, as in a .gitignore. */
export function matchGlobs(
  globs: IgnoreGlob[],
  path: string,
  isDir: boolean,
): GlobMatch {
  for (let i = globs.length - 1; i >= 0; i--) {
    const glob = globs[i];
    if (glob.dirOnly && !isDir) continue;
    if (glob.regex.test(path)) return glob.whitelist ? "whitelist" : "ignore";
  }
  return "none";
}

/**
 * -g and --iglob: a glob selects, `!` excludes, the last match decides,
 * and with any selecting glob a file no glob matched is excluded.
 */
export class Overrides {
  private readonly globs: IgnoreGlob[] = [];
  private whitelists = 0;

  add(glob: string, caseInsensitive: boolean): void {
    const compiled = compileIgnoreGlob(glob, caseInsensitive);
    // an override inverts the ignore-file meaning
    compiled.whitelist = !compiled.whitelist;
    if (compiled.whitelist) this.whitelists++;
    this.globs.push(compiled);
  }

  get empty(): boolean {
    return this.globs.length === 0;
  }

  match(path: string, isDir: boolean): GlobMatch {
    if (this.globs.length === 0) return "none";
    const found = matchGlobs(this.globs, path.replace(/^\.\//, ""), isDir);
    if (found === "none" && this.whitelists > 0 && !isDir) return "ignore";
    return found;
  }
}
