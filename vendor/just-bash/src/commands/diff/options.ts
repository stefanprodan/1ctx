/**
 * (1ctx) GNU diff 3.12's options, read as its getopt_long reads them:
 * options may follow operands, `--` ends them, a value follows in the same
 * argument or the next, a value-taking option ends a cluster, digits are
 * the obsolete context length, and a long option may be any unambiguous
 * prefix. Every refusal is exit 2, GNU's trouble.
 */

export type Style = "normal" | "unified" | "context";

export interface DiffOptions {
  /** the output style an option chose, null for the default */
  style: Style | null;
  /**
   * the most lines of context asked for: -C, -U and their long forms ask
   * for their value, -c and -u for 3
   */
  context: number | null;
  /** the obsolete -NUM, which wins over the rest */
  obsolete: number | null;
  brief: boolean;
  reportSame: boolean;
  text: boolean;
  minimal: boolean;
  speedLargeFiles: boolean;
  horizon: number;
  ignoreCase: boolean;
  ignoreTabExpansion: boolean;
  ignoreTrailingSpace: boolean;
  ignoreSpaceChange: boolean;
  ignoreAllSpace: boolean;
  ignoreBlankLines: boolean;
  ignoreMatching: string[];
  stripTrailingCr: boolean;
  labels: string[];
  /** -F values in the order given; -p adds GNU's C pattern */
  functionPatterns: string[];
  /** -p: context format unless a style was chosen */
  showCFunction: boolean;
  initialTab: boolean;
  expandTabs: boolean;
  tabSize: number;
  suppressBlankEmpty: boolean;
  help: boolean;
  version: boolean;
}

/** What GNU's -p matches, as its manual gives it. */
export const C_FUNCTION = "^[[:alpha:]$_]";

export class DiffUsageError extends Error {
  constructor(
    message: string,
    readonly tryHelp = true,
  ) {
    super(message);
  }
}

type Arg = "none" | "required" | "optional";

interface Spec {
  arg: Arg;
  apply: (o: DiffOptions, value: string, name: string) => void;
}

const flag = (set: (o: DiffOptions) => void): Spec => ({
  arg: "none",
  apply: (o) => set(o),
});

function setStyle(o: DiffOptions, style: Style): void {
  if (o.style !== null && o.style !== style) {
    throw new DiffUsageError("conflicting output style options");
  }
  o.style = style;
}

function ask(o: DiffOptions, lines: number): void {
  o.context = o.context === null ? lines : Math.max(o.context, lines);
}

function contextLength(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new DiffUsageError(`invalid context length '${value}'`);
  }
  return Math.min(Number(value), Number.MAX_SAFE_INTEGER);
}

function number(what: string, value: string, min: number): number {
  if (!/^[0-9]+$/.test(value) || Number(value) < min) {
    throw new DiffUsageError(`invalid ${what} '${value}'`);
  }
  return Number(value);
}

/** Refused here: what needs a tool the shell lacks, or escape codes. */
const refuse = (arg: Arg, words: string): Spec => ({
  arg,
  apply: () => {
    throw new DiffUsageError(words, false);
  },
});

/** Kept for a later change; refused so nothing is dropped without a word. */
const later = (arg: Arg): Spec => ({
  arg,
  apply: (_o, _v, name) => {
    throw new DiffUsageError(`option '${name}' is not supported`, false);
  },
});

/** Options that change nothing when both operands are files. */
const ignored = (arg: Arg): Spec => ({ arg, apply: () => {} });

const context: Spec = {
  arg: "required",
  apply: (o, v) => {
    setStyle(o, "context");
    ask(o, contextLength(v));
  },
};
const unified: Spec = {
  arg: "required",
  apply: (o, v) => {
    setStyle(o, "unified");
    ask(o, contextLength(v));
  },
};

const SHORT: Record<string, Spec> = {
  a: flag((o) => (o.text = true)),
  b: flag((o) => (o.ignoreSpaceChange = true)),
  B: flag((o) => (o.ignoreBlankLines = true)),
  c: flag((o) => {
    setStyle(o, "context");
    ask(o, 3);
  }),
  C: context,
  d: flag((o) => (o.minimal = true)),
  D: later("required"),
  e: later("none"),
  E: flag((o) => (o.ignoreTabExpansion = true)),
  f: later("none"),
  F: { arg: "required", apply: (o, v) => o.functionPatterns.push(v) },
  i: flag((o) => (o.ignoreCase = true)),
  I: { arg: "required", apply: (o, v) => o.ignoreMatching.push(v) },
  l: refuse("none", "-l is refused: the shell has no pr to paginate with"),
  L: { arg: "required", apply: (o, v) => o.labels.push(v) },
  n: later("none"),
  N: later("none"),
  p: flag((o) => (o.showCFunction = true)),
  q: flag((o) => (o.brief = true)),
  r: ignored("none"),
  s: flag((o) => (o.reportSame = true)),
  S: ignored("required"),
  t: flag((o) => (o.expandTabs = true)),
  T: flag((o) => (o.initialTab = true)),
  u: flag((o) => {
    setStyle(o, "unified");
    ask(o, 3);
  }),
  U: unified,
  v: flag((o) => (o.version = true)),
  w: flag((o) => (o.ignoreAllSpace = true)),
  W: ignored("required"),
  x: ignored("required"),
  X: ignored("required"),
  y: later("none"),
  Z: flag((o) => (o.ignoreTrailingSpace = true)),
};

const LONG: Record<string, Spec> = {
  normal: flag((o) => setStyle(o, "normal")),
  brief: SHORT.q,
  "report-identical-files": SHORT.s,
  context: {
    arg: "optional",
    apply: (o, v) => {
      setStyle(o, "context");
      ask(o, v === "" ? 3 : contextLength(v));
    },
  },
  unified: {
    arg: "optional",
    apply: (o, v) => {
      setStyle(o, "unified");
      ask(o, v === "" ? 3 : contextLength(v));
    },
  },
  ed: SHORT.e,
  "forward-ed": SHORT.f,
  rcs: SHORT.n,
  "side-by-side": SHORT.y,
  width: SHORT.W,
  "left-column": ignored("none"),
  "suppress-common-lines": ignored("none"),
  "show-c-function": SHORT.p,
  "show-function-line": SHORT.F,
  label: SHORT.L,
  "expand-tabs": SHORT.t,
  "initial-tab": SHORT.T,
  tabsize: {
    arg: "required",
    apply: (o, v) => (o.tabSize = number("tabsize", v, 1)),
  },
  "suppress-blank-empty": flag((o) => (o.suppressBlankEmpty = true)),
  paginate: refuse("none", "--paginate is refused: the shell has no pr"),
  recursive: SHORT.r,
  "no-dereference": ignored("none"),
  "new-file": SHORT.N,
  "unidirectional-new-file": later("none"),
  "ignore-file-name-case": ignored("none"),
  "no-ignore-file-name-case": ignored("none"),
  exclude: SHORT.x,
  "exclude-from": SHORT.X,
  "starting-file": SHORT.S,
  "from-file": later("required"),
  "to-file": later("required"),
  "ignore-case": SHORT.i,
  "ignore-tab-expansion": SHORT.E,
  "ignore-trailing-space": SHORT.Z,
  "ignore-space-change": SHORT.b,
  "ignore-all-space": SHORT.w,
  "ignore-blank-lines": SHORT.B,
  "ignore-matching-lines": SHORT.I,
  text: SHORT.a,
  "strip-trailing-cr": flag((o) => (o.stripTrailingCr = true)),
  ifdef: SHORT.D,
  "old-group-format": later("required"),
  "new-group-format": later("required"),
  "unchanged-group-format": later("required"),
  "changed-group-format": later("required"),
  "line-format": later("required"),
  "old-line-format": later("required"),
  "new-line-format": later("required"),
  "unchanged-line-format": later("required"),
  minimal: SHORT.d,
  "horizon-lines": {
    arg: "required",
    apply: (o, v) => (o.horizon = number("horizon length", v, 0)),
  },
  "speed-large-files": flag((o) => (o.speedLargeFiles = true)),
  color: {
    arg: "optional",
    apply: (_o, v) => {
      // never a terminal here, so auto is never
      if (v === "" || v === "never" || v === "auto" || v === "none") return;
      if (v === "always" || v === "yes" || v === "force") {
        throw new DiffUsageError(
          "--color=always is refused: escape codes say nothing here",
          false,
        );
      }
      throw new DiffUsageError(`invalid argument '${v}' for '--color'`);
    },
  },
  palette: refuse("required", "--palette is refused: it only serves --color=always"),
  binary: ignored("none"),
  help: flag((o) => (o.help = true)),
  version: SHORT.v,
};

export function parseDiffArgs(args: string[]): {
  options: DiffOptions;
  operands: string[];
} {
  const o: DiffOptions = {
    style: null,
    context: null,
    obsolete: null,
    brief: false,
    reportSame: false,
    text: false,
    minimal: false,
    speedLargeFiles: false,
    horizon: 0,
    ignoreCase: false,
    ignoreTabExpansion: false,
    ignoreTrailingSpace: false,
    ignoreSpaceChange: false,
    ignoreAllSpace: false,
    ignoreBlankLines: false,
    ignoreMatching: [],
    stripTrailingCr: false,
    labels: [],
    functionPatterns: [],
    showCFunction: false,
    initialTab: false,
    expandTabs: false,
    tabSize: 8,
    suppressBlankEmpty: false,
    help: false,
    version: false,
  };
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let full = name;
      if (!LONG[name]) {
        const candidates = Object.keys(LONG).filter((n) => n.startsWith(name));
        const distinct = new Set(candidates.map((n) => LONG[n]));
        if (candidates.length === 0) {
          throw new DiffUsageError(
            `unrecognized option '${eq === -1 ? arg : arg.slice(0, eq)}'`,
          );
        }
        if (distinct.size > 1) {
          throw new DiffUsageError(
            `option '--${name}' is ambiguous; possibilities: ${candidates
              .map((n) => `'--${n}'`)
              .join(" ")}`,
          );
        }
        full = candidates[0];
      }
      const spec = LONG[full];
      if (spec.arg === "none") {
        if (eq !== -1) {
          throw new DiffUsageError(
            `option '--${full}' doesn't allow an argument`,
          );
        }
        spec.apply(o, "", `--${full}`);
      } else if (eq !== -1) {
        spec.apply(o, arg.slice(eq + 1), `--${full}`);
      } else if (spec.arg === "optional") {
        spec.apply(o, "", `--${full}`);
      } else if (i + 1 < args.length) {
        spec.apply(o, args[++i], `--${full}`);
      } else {
        throw new DiffUsageError(`option '--${full}' requires an argument`);
      }
      continue;
    }
    // a run of digits is the obsolete context length
    let digits = "";
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch >= "0" && ch <= "9") {
        digits += ch;
        o.obsolete = contextLength(digits);
        continue;
      }
      digits = "";
      const spec = SHORT[ch];
      if (!spec) throw new DiffUsageError(`invalid option -- '${ch}'`);
      if (spec.arg === "none") {
        spec.apply(o, "", `-${ch}`);
        continue;
      }
      const rest = arg.slice(j + 1);
      if (rest !== "") spec.apply(o, rest, `-${ch}`);
      else if (i + 1 < args.length) spec.apply(o, args[++i], `-${ch}`);
      else throw new DiffUsageError(`option requires an argument -- '${ch}'`);
      break;
    }
  }
  if (o.labels.length > 2) throw new DiffUsageError("too many file label options");
  if (o.showCFunction) o.functionPatterns.push(C_FUNCTION);
  return { options: o, operands };
}
