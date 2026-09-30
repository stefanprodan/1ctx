/**
 * (1ctx) GNU diff 3.12's options, read as its getopt_long reads them:
 * options may follow operands, `--` ends them, a value follows in the same
 * argument or the next, a value-taking option ends a cluster, digits are
 * the obsolete context length, and a long option may be any unambiguous
 * prefix. Every refusal is exit 2, GNU's trouble.
 */

export type Style =
  | "normal"
  | "unified"
  | "context"
  | "side"
  | "ed"
  | "forward-ed"
  | "rcs"
  | "ifdef";

/** The indexes of the line and group formats, as GNU numbers them. */
export const UNCHANGED = 0;
export const OLD = 1;
export const NEW = 2;
export const CHANGED = 3;

export interface DiffOptions {
  /** the output style an option chose, null for the default */
  style: Style | null;
  /** the most lines of context -C, -U or their long forms asked for */
  context: number | null;
  /** -c, -u or a long form without a value: 3 lines unless more */
  implied: boolean;
  /** the largest obsolete -NUM */
  obsolete: number | null;
  /** -N: an absent file is empty; --unidirectional-new-file: the first */
  newFile: "both" | "first" | null;
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
  /** -r: compare common subdirectories too */
  recursive: boolean;
  /** -x patterns, and -X files of them, in the order given */
  excludes: string[];
  excludeFiles: string[];
  /** -S: the first name compared in the top directories */
  startingFile: string | null;
  fromFile: string | null;
  toFile: string | null;
  ignoreFileNameCase: boolean;
  noDereference: boolean;
  /** the arguments read as options, for the line naming each pair */
  switches: string[];
  /** --tabsize was given */
  tabSizeGiven: boolean;
  /** -W, 0 until given */
  width: number;
  leftColumn: boolean;
  suppressCommonLines: boolean;
  /** --sdiff-merge-assist, sdiff's side of diff */
  mergeAssist: boolean;
  /** --LTYPE-line-format by UNCHANGED, OLD and NEW */
  lineFormats: (string | null)[];
  /** --GTYPE-group-format by UNCHANGED, OLD, NEW and CHANGED */
  groupFormats: (string | null)[];
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

/**
 * The lines of context, as GNU's answers show: the largest -C or -U, at
 * least 3 beside -c or -u, but beside the obsolete -NUM only the largest
 * of it and -C or -U.
 */
export function contextLines(o: DiffOptions): number {
  if (o.obsolete !== null) return Math.max(o.obsolete, o.context ?? 0);
  if (o.context !== null) return o.implied ? Math.max(o.context, 3) : o.context;
  return 3;
}

function contextLength(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new DiffUsageError(`invalid context length '${value}'`);
  }
  return Math.min(Number(value), Number.MAX_SAFE_INTEGER);
}

/** A value an option may be given twice, the same, as GNU's specify_value. */
function specify(had: string | null, value: string, name: string): string {
  if (had !== null && had !== value) {
    throw new DiffUsageError(`conflicting ${name} option value '${value}'`);
  }
  return value;
}

function once(
  o: DiffOptions,
  key: "startingFile" | "fromFile" | "toFile",
  value: string,
  name: string,
): void {
  o[key] = specify(o[key], value, name);
}

/** -W and --tabsize: a second, different value is fatal. */
function size(
  o: DiffOptions,
  key: "width" | "tabSize",
  what: string,
  value: string,
): void {
  if (!/^\+?[0-9]+$/.test(value) || Number(value) <= 0) {
    throw new DiffUsageError(`invalid ${what} '${value}'`);
  }
  const n = Number(value);
  const given = key === "width" ? o.width !== 0 : o.tabSizeGiven;
  if (given && o[key] !== n) {
    throw new DiffUsageError(`conflicting ${what} options`, false);
  }
  o[key] = n;
  if (key === "tabSize") o.tabSizeGiven = true;
}

const C_IFDEF = [
  "%=",
  "#ifndef @\n%<#endif /* ! @ */\n",
  "#ifdef @\n%>#endif /* @ */\n",
  "#ifndef @\n%<#else /* @ */\n%>#endif /* @ */\n",
];

const LINE_OPTIONS = [
  "--unchanged-line-format",
  "--old-line-format",
  "--new-line-format",
];
const GROUP_OPTIONS = [
  "--unchanged-group-format",
  "--old-group-format",
  "--new-group-format",
  "--changed-group-format",
];

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

/** Options that change nothing here. */
const ignored = (arg: Arg): Spec => ({ arg, apply: () => {} });

const lineFormat = (index: number): Spec => ({
  arg: "required",
  apply: (o, v) => {
    setStyle(o, "ifdef");
    o.lineFormats[index] = specify(
      o.lineFormats[index],
      v,
      LINE_OPTIONS[index],
    );
  },
});

const groupFormat = (index: number): Spec => ({
  arg: "required",
  apply: (o, v) => {
    setStyle(o, "ifdef");
    o.groupFormats[index] = specify(
      o.groupFormats[index],
      v,
      GROUP_OPTIONS[index],
    );
  },
});

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
    o.implied = true;
  }),
  C: context,
  d: flag((o) => (o.minimal = true)),
  D: {
    arg: "required",
    apply: (o, v) => {
      setStyle(o, "ifdef");
      C_IFDEF.forEach((format, i) => {
        o.groupFormats[i] = specify(
          o.groupFormats[i],
          format.replaceAll("@", v),
          "-D",
        );
      });
    },
  },
  e: flag((o) => setStyle(o, "ed")),
  E: flag((o) => (o.ignoreTabExpansion = true)),
  f: flag((o) => setStyle(o, "forward-ed")),
  F: { arg: "required", apply: (o, v) => o.functionPatterns.push(v) },
  h: ignored("none"),
  H: flag((o) => (o.speedLargeFiles = true)),
  i: flag((o) => (o.ignoreCase = true)),
  I: { arg: "required", apply: (o, v) => o.ignoreMatching.push(v) },
  l: refuse("none", "-l is refused: the shell has no pr to paginate with"),
  L: { arg: "required", apply: (o, v) => o.labels.push(v) },
  n: flag((o) => setStyle(o, "rcs")),
  N: flag((o) => (o.newFile = "both")),
  p: flag((o) => (o.showCFunction = true)),
  P: flag((o) => {
    if (o.newFile === null) o.newFile = "first";
  }),
  q: flag((o) => (o.brief = true)),
  r: flag((o) => (o.recursive = true)),
  s: flag((o) => (o.reportSame = true)),
  S: {
    arg: "required",
    apply: (o, v) => once(o, "startingFile", v, "-S"),
  },
  t: flag((o) => (o.expandTabs = true)),
  T: flag((o) => (o.initialTab = true)),
  u: flag((o) => {
    setStyle(o, "unified");
    o.implied = true;
  }),
  U: unified,
  v: flag((o) => (o.version = true)),
  w: flag((o) => (o.ignoreAllSpace = true)),
  W: { arg: "required", apply: (o, v) => size(o, "width", "width", v) },
  x: { arg: "required", apply: (o, v) => o.excludes.push(v) },
  X: { arg: "required", apply: (o, v) => o.excludeFiles.push(v) },
  y: flag((o) => setStyle(o, "side")),
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
      if (v === "") o.implied = true;
      else ask(o, contextLength(v));
    },
  },
  unified: {
    arg: "optional",
    apply: (o, v) => {
      setStyle(o, "unified");
      if (v === "") o.implied = true;
      else ask(o, contextLength(v));
    },
  },
  ed: SHORT.e,
  "forward-ed": SHORT.f,
  rcs: SHORT.n,
  "side-by-side": SHORT.y,
  width: SHORT.W,
  "left-column": flag((o) => (o.leftColumn = true)),
  "suppress-common-lines": flag((o) => (o.suppressCommonLines = true)),
  "sdiff-merge-assist": flag((o) => {
    setStyle(o, "side");
    o.mergeAssist = true;
  }),
  "show-c-function": SHORT.p,
  "show-function-line": SHORT.F,
  label: SHORT.L,
  "expand-tabs": SHORT.t,
  "initial-tab": SHORT.T,
  tabsize: {
    arg: "required",
    apply: (o, v) => size(o, "tabSize", "tabsize", v),
  },
  "suppress-blank-empty": flag((o) => (o.suppressBlankEmpty = true)),
  paginate: refuse("none", "--paginate is refused: the shell has no pr"),
  recursive: SHORT.r,
  "no-dereference": flag((o) => (o.noDereference = true)),
  "new-file": SHORT.N,
  "unidirectional-new-file": SHORT.P,
  "ignore-file-name-case": flag((o) => (o.ignoreFileNameCase = true)),
  "no-ignore-file-name-case": flag((o) => (o.ignoreFileNameCase = false)),
  exclude: SHORT.x,
  "exclude-from": SHORT.X,
  "starting-file": SHORT.S,
  "from-file": {
    arg: "required",
    apply: (o, v) => once(o, "fromFile", v, "--from-file"),
  },
  "to-file": {
    arg: "required",
    apply: (o, v) => once(o, "toFile", v, "--to-file"),
  },
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
  "old-group-format": groupFormat(OLD),
  "new-group-format": groupFormat(NEW),
  "unchanged-group-format": groupFormat(UNCHANGED),
  "changed-group-format": groupFormat(CHANGED),
  "line-format": {
    arg: "required",
    apply: (o, v) => {
      setStyle(o, "ifdef");
      for (let i = 0; i < LINE_OPTIONS.length; i++) {
        o.lineFormats[i] = specify(o.lineFormats[i], v, "--line-format");
      }
    },
  },
  "old-line-format": lineFormat(OLD),
  "new-line-format": lineFormat(NEW),
  "unchanged-line-format": lineFormat(UNCHANGED),
  minimal: SHORT.d,
  "horizon-lines": {
    arg: "required",
    apply: (o, v) => (o.horizon = number("horizon length", v, 0)),
  },
  "speed-large-files": SHORT.H,
  "inhibit-hunk-merge": ignored("none"),
  color: {
    arg: "optional",
    apply: (_o, v) => {
      // every form prints plain text: escape codes say nothing to a model
      if (["", "never", "auto", "always"].includes(v)) return;
      throw new DiffUsageError(`invalid argument '${v}' for '--color'`);
    },
  },
  palette: ignored("required"),
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
    implied: false,
    newFile: null,
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
    recursive: false,
    excludes: [],
    excludeFiles: [],
    startingFile: null,
    fromFile: null,
    toFile: null,
    ignoreFileNameCase: false,
    noDereference: false,
    switches: [],
    tabSizeGiven: false,
    width: 0,
    leftColumn: false,
    suppressCommonLines: false,
    mergeAssist: false,
    lineFormats: [null, null, null],
    groupFormats: [null, null, null, null],
  };
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      o.switches.push(arg);
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    // what getopt moves before the operands, a value taken from the next
    // argument included
    const start = i;
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
      o.switches.push(...args.slice(start, i + 1));
      continue;
    }
    // a run of digits is the obsolete context length
    let digits = "";
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch >= "0" && ch <= "9") {
        digits += ch;
        o.obsolete = Math.max(o.obsolete ?? 0, contextLength(digits));
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
    o.switches.push(...args.slice(start, i + 1));
  }
  if (o.labels.length > 2) throw new DiffUsageError("too many file label options");
  if (o.showCFunction) o.functionPatterns.push(C_FUNCTION);
  return { options: o, operands };
}

/** The line and group formats with GNU's defaults filled in. */
export function formats(o: DiffOptions): {
  lines: string[];
  groups: string[];
} {
  const g = o.groupFormats;
  const old = g[OLD] ?? g[CHANGED] ?? "%<";
  const added = g[NEW] ?? g[CHANGED] ?? "%>";
  return {
    lines: o.lineFormats.map((f) => f ?? "%l\n"),
    groups: [g[UNCHANGED] ?? "%=", old, added, g[CHANGED] ?? old + added],
  };
}

/** Whether two files the same print nothing, GNU's no_diff_means_no_output. */
export function noDiffMeansNoOutput(o: DiffOptions): boolean {
  if (o.style === "ifdef") {
    const { lines, groups } = formats(o);
    return (
      groups[UNCHANGED] === "" ||
      (groups[UNCHANGED] === "%=" && lines[UNCHANGED] === "")
    );
  }
  return o.style !== "side" || o.suppressCommonLines;
}
