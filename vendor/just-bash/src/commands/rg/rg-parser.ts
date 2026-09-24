/**
 * Argument parsing for rg command
 *
 * (1ctx) ripgrep's parser: `--` ends the options, a value-taking short
 * option takes the rest of its cluster or the next argument, a long one
 * `=VALUE` or the next argument, options may follow operands, and every
 * refusal exits 2 in ripgrep's words.
 */

import type { ExecResult } from "../../types.js";
import {
  createDefaultOptions,
  type RgOptions,
  type SortKey,
} from "./rg-options.js";

export interface ParseResult {
  success: true;
  options: RgOptions;
  paths: string[];
}

export interface ParseError {
  success: false;
  error: ExecResult;
}

export type ParseArgsResult = ParseResult | ParseError;

/** A refusal in ripgrep's words, exit 2. */
function refuse(message: string): ParseError {
  return {
    success: false,
    error: { stdout: "", stderr: `rg: ${message}\n`, exitCode: 2 },
  };
}

interface State {
  after: number | null;
  before: number | null;
  context: number | null;
}

/** Returns an error message for a value it refuses. */
type Apply = (
  o: RgOptions,
  value: string,
  state: State,
) => string | undefined;

interface Spec {
  value: boolean;
  apply: Apply;
}

const flag = (set: (o: RgOptions) => void): Spec => ({
  value: false,
  apply: (o) => {
    set(o);
    return undefined;
  },
});

const text = (set: (o: RgOptions, v: string) => void): Spec => ({
  value: true,
  apply: (o, v) => {
    set(o, v);
    return undefined;
  },
});

function number(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

const count = (set: (o: RgOptions, n: number, s: State) => void): Spec => ({
  value: true,
  apply: (o, v, s) => {
    const n = number(v);
    if (n === null) {
      return "value is not a valid number: invalid digit found in string";
    }
    set(o, n, s);
    return undefined;
  },
});

/** --context-separator and the field separators read escapes. */
function unescape(value: string): string {
  return value.replace(/\\(x[0-9A-Fa-f]{2}|[tnr0\\])/g, (_, e: string) => {
    if (e[0] === "x") return String.fromCharCode(Number.parseInt(e.slice(1), 16));
    return { t: "\t", n: "\n", r: "\r", "0": "\0", "\\": "\\" }[e] ?? e;
  });
}

/** A value from a closed list, then any refusal of its own. */
function choice(
  allowed: string[],
  check: (o: RgOptions, v: string) => string | undefined = () => undefined,
): Spec {
  return {
    value: true,
    apply: (o, v) =>
      allowed.includes(v) ? check(o, v) : `choice '${v}' is unrecognized`,
  };
}

const SORT_KEYS = ["path", "none", "modified", "accessed", "created"];

const sortKey = (reverse: boolean): Spec =>
  choice(SORT_KEYS, (o, v) => {
    o.sort = v as SortKey;
    o.sortReverse = reverse;
    return undefined;
  });

/** Files are read as UTF-8: another encoding is refused, an unknown one too. */
function encodingRefusal(label: string): string | undefined {
  const name = label.toLowerCase();
  if (name === "none" || name === "auto") return undefined;
  let encoding: string;
  try {
    encoding = new TextDecoder(name).encoding;
  } catch {
    return `grep config error: unknown encoding: ${label}`;
  }
  if (encoding === "utf-8") return undefined;
  return `encoding ${label} is not supported: files are read as UTF-8`;
}

const caseMode = (mode: "i" | "s" | "S") =>
  flag((o) => {
    o.ignoreCase = mode === "i";
    o.caseSensitive = mode === "s";
    o.smartCase = mode === "S";
  });

const SPECS: Record<string, Spec> = {
  "ignore-case": caseMode("i"),
  "case-sensitive": caseMode("s"),
  "smart-case": caseMode("S"),
  "fixed-strings": flag((o) => (o.fixedStrings = true)),
  "word-regexp": flag((o) => (o.wordRegexp = true)),
  "line-regexp": flag((o) => (o.lineRegexp = true)),
  "invert-match": flag((o) => (o.invertMatch = true)),
  multiline: flag((o) => (o.multiline = true)),
  "multiline-dotall": flag((o) => {
    o.multilineDotall = true;
    o.multiline = true;
  }),
  count: flag((o) => (o.count = true)),
  "count-matches": flag((o) => (o.countMatches = true)),
  "files-with-matches": flag((o) => (o.filesWithMatches = true)),
  files: flag((o) => (o.files = true)),
  "files-without-match": flag((o) => (o.filesWithoutMatch = true)),
  stats: flag((o) => (o.stats = true)),
  "only-matching": flag((o) => (o.onlyMatching = true)),
  quiet: flag((o) => (o.quiet = true)),
  "line-number": flag((o) => (o.lineNumber = true)),
  "no-line-number": flag((o) => (o.lineNumber = false)),
  "with-filename": flag((o) => {
    o.withFilename = true;
    o.noFilename = false;
  }),
  "no-filename": flag((o) => {
    o.noFilename = true;
    o.withFilename = false;
  }),
  null: flag((o) => (o.nullSeparator = true)),
  // (1ctx) ripgrep's NUL-terminated lines
  "null-data": flag((o) => (o.nullData = true)),
  "byte-offset": flag((o) => (o.byteOffset = true)),
  column: flag((o) => {
    o.column = true;
    o.lineNumber = true;
  }),
  "no-column": flag((o) => (o.column = false)),
  vimgrep: flag((o) => {
    o.vimgrep = true;
    o.column = true;
    o.lineNumber = true;
  }),
  json: flag((o) => (o.json = true)),
  hidden: flag((o) => (o.hidden = true)),
  "no-ignore": flag((o) => (o.noIgnore = true)),
  "no-ignore-dot": flag((o) => (o.noIgnoreDot = true)),
  "no-ignore-vcs": flag((o) => (o.noIgnoreVcs = true)),
  follow: flag((o) => (o.followSymlinks = true)),
  "search-zip": flag((o) => (o.searchZip = true)),
  text: flag((o) => (o.searchBinary = true)),
  heading: flag((o) => (o.heading = true)),
  passthru: flag((o) => (o.passthru = true)),
  "include-zero": flag((o) => (o.includeZero = true)),
  "glob-case-insensitive": flag((o) => (o.globCaseInsensitive = true)),
  "no-context-separator": flag((o) => (o.contextSeparator = null)),
  // -u, -uu, -uuu: no ignore files, then hidden, then binary
  unrestricted: flag((o) => {
    if (o.hidden) o.binary = true;
    else if (o.noIgnore) o.hidden = true;
    else o.noIgnore = true;
  }),
  // (1ctx) the options ripgrep has that were refused
  "no-heading": flag((o) => (o.heading = false)),
  pretty: flag((o) => {
    o.heading = true;
    o.lineNumber = true;
  }),
  "max-columns-preview": flag((o) => (o.maxColumnsPreview = true)),
  "no-max-columns-preview": flag((o) => (o.maxColumnsPreview = false)),
  trim: flag((o) => (o.trim = true)),
  "no-trim": flag((o) => (o.trim = false)),
  binary: flag((o) => (o.binary = true)),
  "no-binary": flag((o) => (o.binary = false)),
  crlf: flag((o) => (o.crlf = true)),
  "no-crlf": flag((o) => (o.crlf = false)),
  "no-messages": flag((o) => (o.noMessages = true)),
  messages: flag((o) => (o.noMessages = false)),
  "no-ignore-parent": flag((o) => (o.noIgnoreParent = true)),
  "no-ignore-files": flag((o) => (o.noIgnoreFiles = true)),
  "require-git": flag((o) => (o.requireGit = true)),
  "no-require-git": flag((o) => (o.requireGit = false)),
  "no-unicode": flag((o) => (o.unicode = false)),
  unicode: flag((o) => (o.unicode = true)),
  pcre2: flag((o) => (o.pcre = true)),
  "no-pcre2": flag((o) => (o.pcre = false)),
  "sort-files": flag((o) => {
    o.sort = "path";
    o.sortReverse = false;
  }),
  "type-list": flag((o) => (o.typeList = true)),
  version: flag((o) => (o.version = "long")),
  // nothing here reads a config file, a terminal or other file systems
  "no-config": flag(() => undefined),
  "one-file-system": flag(() => undefined),
  "no-one-file-system": flag(() => undefined),
  "line-buffered": flag(() => undefined),
  "block-buffered": flag(() => undefined),
  "no-ignore-global": flag(() => undefined),
  "no-ignore-exclude": flag(() => undefined),
  "auto-hybrid-regex": flag(() => undefined),
  "no-auto-hybrid-regex": flag(() => undefined),
  "pcre2-unicode": flag(() => undefined),
  "no-pcre2-unicode": flag(() => undefined),
  debug: flag(() => undefined),
  colors: text(() => undefined),
  color: choice(["never", "auto", "always", "ansi"], (_, v) =>
    v === "always" || v === "ansi"
      ? `--color=${v} is not supported: output is always plain`
      : undefined,
  ),
  engine: {
    value: true,
    apply: (o, v) => {
      if (v !== "default" && v !== "auto" && v !== "pcre2") {
        return `unrecognized regex engine '${v}'`;
      }
      o.pcre = v === "pcre2";
      return undefined;
    },
  },
  encoding: {
    value: true,
    apply: (_, v) => encodingRefusal(v),
  },
  "path-separator": {
    value: true,
    apply: (o, v) => {
      const bytes = new TextEncoder().encode(v).length;
      if (bytes !== 1) {
        return `A path separator must be exactly one byte, but the given separator is ${bytes} bytes: ${v}\nIn some shells on Windows '/' is automatically expanded. Use '//' instead.`;
      }
      o.pathSeparator = v;
      return undefined;
    },
  },
  "max-columns": count((o, n) => (o.maxColumns = n)),
  glob: text((o, v) => o.globs.push(v)),
  iglob: text((o, v) => o.iglobs.push(v)),
  type: text((o, v) => o.types.push(v)),
  "type-not": text((o, v) => o.typesNot.push(v)),
  "type-add": text((o, v) => o.typeChanges.push({ kind: "add", value: v })),
  "type-clear": text((o, v) =>
    o.typeChanges.push({ kind: "clear", value: v }),
  ),
  regexp: text((o, v) => o.patterns.push(v)),
  file: text((o, v) => o.patternFiles.push(v)),
  replace: text((o, v) => (o.replace = v)),
  "context-separator": text((o, v) => (o.contextSeparator = unescape(v))),
  "field-context-separator": text(
    (o, v) => (o.fieldContextSeparator = unescape(v)),
  ),
  "field-match-separator": text(
    (o, v) => (o.fieldMatchSeparator = unescape(v)),
  ),
  "ignore-file": text((o, v) => o.ignoreFiles.push(v)),
  pre: text((o, v) => (o.preprocessor = v)),
  "pre-glob": text((o, v) => o.preprocessorGlobs.push(v)),
  "max-count": count((o, n) => (o.maxCount = n)),
  "max-depth": count((o, n) => (o.maxDepth = n)),
  // a no-op in a single-threaded shell, never stored
  threads: count(() => undefined),
  "after-context": count((_, n, s) => (s.after = n)),
  "before-context": count((_, n, s) => (s.before = n)),
  context: count((_, n, s) => (s.context = n)),
  "max-filesize": {
    value: true,
    apply: (o, v) => {
      const m = v.match(/^(\d+)([KMG])?$/);
      if (!m) {
        return `invalid size: invalid format for size '${v}', which should be a non-empty sequence of digits followed by an optional 'K', 'M' or 'G' suffix`;
      }
      const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2] ?? ""] ?? 1;
      o.maxFilesize = Number(m[1]) * unit;
      return undefined;
    },
  },
  sort: sortKey(false),
  sortr: sortKey(true),
};

const ALIASES: Record<string, string> = {
  passthrough: "passthru",
  maxdepth: "max-depth",
};

const SHORT: Record<string, string> = {
  i: "ignore-case",
  s: "case-sensitive",
  S: "smart-case",
  F: "fixed-strings",
  w: "word-regexp",
  x: "line-regexp",
  v: "invert-match",
  U: "multiline",
  c: "count",
  l: "files-with-matches",
  o: "only-matching",
  q: "quiet",
  n: "line-number",
  N: "no-line-number",
  H: "with-filename",
  I: "no-filename",
  "0": "null",
  b: "byte-offset",
  ".": "hidden",
  L: "follow",
  z: "search-zip",
  a: "text",
  u: "unrestricted",
  g: "glob",
  t: "type",
  T: "type-not",
  e: "regexp",
  f: "file",
  r: "replace",
  m: "max-count",
  d: "max-depth",
  j: "threads",
  A: "after-context",
  B: "before-context",
  C: "context",
  M: "max-columns",
  E: "encoding",
  p: "pretty",
  P: "pcre2",
};

/**
 * Parse rg command arguments
 */
export function parseArgs(args: string[]): ParseArgsResult {
  const options = createDefaultOptions();
  const state: State = { after: null, before: null, context: null };
  const positionals: string[] = [];

  const take = (
    name: string,
    shown: string,
    inline: string | undefined,
    i: number,
  ): { next: number; error?: ParseError } => {
    const spec = SPECS[name];
    let value = inline;
    let next = i;
    if (spec.value && value === undefined) {
      if (i + 1 >= args.length) {
        return {
          next,
          error: refuse(
            `missing value for flag ${shown}: missing argument for option '${shown}'`,
          ),
        };
      }
      value = args[i + 1];
      next = i + 1;
    }
    const message = spec.apply(options, value ?? "", state);
    if (message !== undefined) {
      return { next, error: refuse(`error parsing flag ${shown}: ${message}`) };
    }
    return { next };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const written = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const name = ALIASES[written] ?? written;
      const shown = `--${written}`;
      const spec = SPECS[name];
      if (!spec) return refuse(`unrecognized flag ${shown}`);
      const inline = eq < 0 ? undefined : arg.slice(eq + 1);
      if (!spec.value && inline !== undefined) {
        return refuse(`error parsing flag ${shown}: flag does not take a value`);
      }
      const taken = take(name, shown, inline, i);
      if (taken.error) return taken.error;
      i = taken.next;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      for (let k = 1; k < arg.length; k++) {
        const ch = arg[k];
        // -V is ripgrep's one line, --version its whole text
        if (ch === "V") {
          options.version ??= "short";
          continue;
        }
        const name = SHORT[ch];
        if (!name) return refuse(`unrecognized flag -${ch}`);
        if (SPECS[name].value) {
          const rest = arg.slice(k + 1);
          const taken = take(name, `-${ch}`, rest === "" ? undefined : rest, i);
          if (taken.error) return taken.error;
          i = taken.next;
          break;
        }
        take(name, `-${ch}`, undefined, i);
      }
      continue;
    }
    positionals.push(arg);
  }

  // -A and -B win over -C whatever their order
  options.afterContext = state.after ?? state.context ?? 0;
  options.beforeContext = state.before ?? state.context ?? 0;

  // (1ctx) ripgrep prints counts and names as they are under --json
  if (
    options.count ||
    options.countMatches ||
    options.files ||
    options.filesWithMatches ||
    options.filesWithoutMatch
  ) {
    options.json = false;
  }

  const paths = positionals.slice();
  if (
    !options.files &&
    options.patterns.length === 0 &&
    options.patternFiles.length === 0 &&
    paths.length > 0
  ) {
    options.patterns.push(paths.shift() as string);
  }

  return { success: true, options, paths };
}
