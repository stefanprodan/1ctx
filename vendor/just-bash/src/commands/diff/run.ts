/**
 * (1ctx) What diff compares, as GNU diff 3.12's compare_files and
 * diff_dirs do: two files, a file and its namesake in a directory, or two
 * directories, their entries sorted and paired, `Only in`, `Common
 * subdirectories` and `File X is a T while file Y is a U`, recursing with
 * -r, an absent file read as empty under -N, -x, -X and -S filtering the
 * names. Each nested pair that prints is named by a `diff` line. Trouble
 * with one pair is written to stderr and the walk goes on; the status is
 * the worst of all.
 */

import { latin1FromBytes, readBytesFrom } from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import type { FsStat } from "../../fs/interface.js";
import { FileTraversalBudget } from "../../fs/traversal.js";
import type { RuntimeCommandContext } from "../../types.js";
import type { WorkBudget } from "./budget.js";
import { headerName, localeQuote, shellName, shellWord } from "./header.js";
import {
  byteOrder,
  caseOrder,
  collates,
  excluder,
  fileType,
  type NameOrder,
  nameOrder,
} from "./names.js";
import { type DiffOptions, noDiffMeansNoOutput } from "./options.js";
import { diffTexts, type Tests, text } from "./text.js";

/** (1ctx) A NUL in this many first bytes makes a file binary, as GNU's first read. */
const BINARY_WINDOW = 4096;
/** (1ctx) GNU reads this much of a pipe at first, so stdin looks further. */
const PIPE_WINDOW = 65536;

/** Trouble GNU stops for at once, exit 2. */
export class Fatal extends Error {}

interface Side {
  name: string;
  /** absent, and read as empty under -N */
  none: boolean;
  stdin: boolean;
  stat: FsStat | null;
  /** the errno name of a failed stat */
  err: string | null;
  words: string;
}

interface Pair {
  names: [string, string];
  stats: [FsStat | null, FsStat | null];
  parent: Pair | null;
  depth: number;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code) return code;
  const message = error instanceof Error ? error.message : String(error);
  return /^(E[A-Z]+)\b/.exec(message)?.[1] ?? "EIO";
}

function errorWords(error: unknown): string {
  switch (errorCode(error)) {
    case "ENOENT":
      return "No such file or directory";
    case "ENOTDIR":
      return "Not a directory";
    case "EACCES":
      return "Permission denied";
    case "EISDIR":
      return "Is a directory";
    case "ELOOP":
      return "Too many levels of symbolic links";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

const missing = (err: string | null) => err === "ENOENT" || err === "ENOTDIR";

/** gnulib's last_component: past the last slash that has a name after it. */
export function lastComponent(name: string): string {
  let base = 0;
  while (name[base] === "/") base++;
  let slash = false;
  for (let i = base; i < name.length; i++) {
    if (name[i] === "/") slash = true;
    else if (slash) {
      base = i;
      slash = false;
    }
  }
  return name.slice(base);
}

/** gnulib's file_name_concat: one slash between a directory and a name. */
export function joinName(dir: string, name: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  if (trimmed === "") return `${dir}${name}`;
  return `${trimmed}/${name}`;
}

/** A stat GNU never took, when the first file's failed: no type, epoch. */
const UNSTATTED: FsStat = {
  isFile: false,
  isDirectory: false,
  isSymbolicLink: false,
  mode: 0,
  size: 0,
  mtime: new Date(0),
};

const STDIN: FsStat = {
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
  mode: 0o644,
  size: -1,
  mtime: new Date(),
};

function sameStat(a: FsStat, b: FsStat): boolean {
  if (a.identity !== undefined || b.identity !== undefined) {
    return a.identity === b.identity;
  }
  if (a.ino !== undefined && b.ino !== undefined) {
    return a.ino === b.ino && a.dev === b.dev;
  }
  return false;
}

export class DiffRun {
  /** stdout's bytes, one character a byte */
  readonly out: string[] = [];
  readonly err: string[] = [];
  private readonly order: NameOrder;
  private readonly excluded: (name: string) => boolean;
  private readonly traversal: FileTraversalBudget;
  private readonly switches: string;
  /** GNU collates names only once the first directories have been read */
  private collating = false;
  private readonly collate: boolean;

  constructor(
    private readonly ctx: RuntimeCommandContext,
    private readonly o: DiffOptions,
    private readonly tests: Tests,
    private readonly budget: WorkBudget,
    excludes: string[],
  ) {
    this.collate = collates(ctx.env);
    this.order = nameOrder(o.ignoreFileNameCase, this.collate);
    this.excluded = excluder(excludes, o.ignoreFileNameCase);
    this.traversal = new FileTraversalBudget({
      limits: ctx.limits,
      signal: ctx.signal,
      executionScope: ctx.executionScope,
      site: "diff",
    });
    this.switches = o.switches.map((s) => ` ${shellWord(s)}`).join("");
  }

  private message(words: string): void {
    this.out.push(text(`${this.o.mergeAssist ? " " : ""}${words}`));
  }

  private trouble(name: string, words: string): void {
    this.err.push(`diff: ${shellName(name)}: ${words}\n`);
  }

  private path(name: string): string {
    return this.ctx.fs.resolvePath(this.ctx.cwd, name);
  }

  private async statSide(side: Side): Promise<void> {
    this.traversal.checkpoint();
    try {
      const path = this.path(side.name);
      side.stat = this.o.noDereference
        ? await this.ctx.fs.lstat(path)
        : await this.ctx.fs.stat(path);
      side.err = null;
    } catch (error) {
      rethrowFatalExecutionError(error);
      side.stat = null;
      side.err = errorCode(error);
      side.words = errorWords(error);
    }
  }

  /** The file named `base` in `dir`, matched ignoring case when asked. */
  private async dirFile(dir: string, base: string): Promise<string> {
    let match = base;
    if (this.o.ignoreFileNameCase) {
      try {
        const names = await this.ctx.fs.readdir(this.path(dir));
        let first: string | null = null;
        for (const name of names) {
          if (caseOrder(name, base) !== 0) continue;
          if (name === base) {
            first = name;
            break;
          }
          first ??= name;
        }
        if (first !== null) match = first;
      } catch (error) {
        rethrowFatalExecutionError(error);
      }
    }
    return joinName(dir, match);
  }

  /**
   * Compares two operands, or two entries of the directories `parent`
   * pairs, one of them null when only the other directory has it.
   */
  async compareFiles(
    parent: Pair | null,
    name0: string | null,
    name1: string | null,
  ): Promise<number> {
    const o = this.o;
    if (
      !(
        (name0 !== null && name1 !== null) ||
        (o.newFile === "first" && name1 !== null) ||
        o.newFile === "both"
      )
    ) {
      const name = (name0 ?? name1) as string;
      const dir = (parent as Pair).names[name0 === null ? 1 : 0];
      this.message(`Only in ${shellName(dir)}: ${shellName(name)}\n`);
      return 1;
    }
    const top = parent === null;
    const n0 = (name0 ?? name1) as string;
    const n1 = (name1 ?? name0) as string;
    const names: [string, string] = top
      ? [n0, n1]
      : [joinName(parent.names[0], n0), joinName(parent.names[1], n1)];
    const sides: Side[] = names.map((name, f) => ({
      name,
      none: (f === 0 ? name0 : name1) === null,
      stdin: false,
      stat: null,
      err: null,
      words: "",
    }));
    for (const f of [0, 1]) {
      const side = sides[f];
      if (side.none) continue;
      if (f === 1 && side.name === sides[0].name && !sides[0].none) {
        // one file named twice: its stat, but its trouble told once
        side.stdin = sides[0].stdin;
        side.stat = sides[0].stat ?? UNSTATTED;
        continue;
      }
      if (side.name === "-") {
        side.stdin = true;
        side.stat = { ...STDIN, mtime: new Date() };
      } else if (f === 1 && sides[0].err !== null) {
        // GNU never stats the second file once the first failed
        side.stat = UNSTATTED;
      } else {
        await this.statSide(side);
      }
    }
    if (top) {
      const [s0, s1] = sides;
      const dir0 = !!s0.stat?.isDirectory;
      const dir1 = !!s1.stat?.isDirectory;
      if (s0.err === null && s1.err === null && dir0 !== dir1) {
        const fileSide = dir0 ? 1 : 0;
        const dirSide = sides[1 - fileSide];
        if (sides[fileSide].stdin) {
          throw new Fatal("cannot compare '-' to a directory");
        }
        dirSide.name = await this.dirFile(
          dirSide.name,
          lastComponent(sides[fileSide].name),
        );
        names[1 - fileSide] = dirSide.name;
        await this.statSide(dirSide);
      }
      for (const f of [0, 1]) {
        if (
          (o.newFile === "both" || (f === 0 && o.newFile === "first")) &&
          missing(sides[f].err) &&
          !missing(sides[1 - f].err)
        ) {
          sides[f].none = true;
          sides[f].err = null;
        }
      }
    }
    for (const f of [0, 1]) {
      if (sides[f].none) sides[f].stat = sides[1 - f].stat;
    }
    let status = 0;
    for (const side of sides) {
      if (side.err !== null) {
        this.trouble(side.name, side.words);
        status = 2;
      }
    }
    if (status === 0) {
      status = await this.comparePrepped(
        parent,
        sides[0],
        sides[1],
        top ? 0 : (parent as Pair).depth + 1,
      );
    }
    if (status === 0 && o.reportSame && !sides[0].stat?.isDirectory) {
      this.message(
        `Files ${o.labels[0] ?? shellName(names[0])} and ${o.labels[1] ?? shellName(names[1])} are identical\n`,
      );
    }
    return status;
  }

  private async comparePrepped(
    parent: Pair | null,
    s0: Side,
    s1: Side,
    depth: number,
  ): Promise<number> {
    const o = this.o;
    if (s0.none && s1.none) return 0;
    const top = parent === null;
    const st0 = s0.stat as FsStat;
    const st1 = s1.stat as FsStat;
    const sameFiles =
      !s0.none &&
      !s1.none &&
      ((s0.stdin && s1.stdin) ||
        (!s0.stdin &&
          !s1.stdin &&
          fileType(st0) === fileType(st1) &&
          sameStat(st0, st1)));
    if (sameFiles && noDiffMeansNoOutput(o)) return 0;

    const pair: Pair = {
      names: [s0.name, s1.name],
      stats: [s0.none ? null : st0, s1.none ? null : st1],
      parent,
      depth,
    };
    if (
      (st0.isDirectory && st1.isDirectory) ||
      (o.recursive &&
        ((o.newFile === "both" && st1.isDirectory && s0.none) ||
          (o.newFile !== null && st0.isDirectory && s1.none)))
    ) {
      if (o.style === "ifdef") {
        throw new Fatal("-D option not supported with directories");
      }
      if (o.recursive || top) return this.diffDirs(pair);
      this.message(
        `Common subdirectories: ${shellName(s0.name)} and ${shellName(s1.name)}\n`,
      );
      return 0;
    }
    if ((s0.none && o.newFile === null) || (s1.none && o.newFile !== "both")) {
      const existing = s0.none ? 1 : 0;
      const dir = parent?.names[existing] ?? ".";
      const base = lastComponent([s0, s1][existing].name);
      this.message(`Only in ${shellName(dir)}: ${shellName(base)}\n`);
      return 1;
    }
    const mismatch = top
      ? st0.isSymbolicLink !== st1.isSymbolicLink
      : st0.isFile
        ? !st1.isFile
        : st0.isSymbolicLink
          ? !st1.isSymbolicLink
          : true;
    if (mismatch) {
      this.message(
        `File ${o.labels[0] ?? shellName(s0.name)} is a ${fileType(st0)} while file ${o.labels[1] ?? shellName(s1.name)} is a ${fileType(st1)}\n`,
      );
      return 1;
    }
    if (st0.isSymbolicLink) return this.compareLinks(s0, s1);

    const read = async (side: Side): Promise<string | null> => {
      if (side.none) return "";
      if (side.stdin) return latin1FromBytes(this.ctx.stdin);
      try {
        return latin1FromBytes(
          await readBytesFrom(this.ctx.fs, this.path(side.name)),
        );
      } catch (error) {
        rethrowFatalExecutionError(error);
        this.trouble(side.name, errorWords(error));
        return null;
      }
    };
    const bytes0 = await read(s0);
    const bytes1 = s1.name === s0.name && !s0.none ? bytes0 : await read(s1);
    if (bytes0 === null || bytes1 === null) return 2;
    const file = (side: Side, bytes: string) => ({
      name: side.name,
      bytes,
      mtime: side.none ? new Date(0) : (side.stat as FsStat).mtime,
      window: side.stdin ? PIPE_WINDOW : BINARY_WINDOW,
    });
    const result = diffTexts(
      { o, tests: this.tests, budget: this.budget, tz: this.ctx.env.get("TZ") },
      file(s0, bytes0),
      file(s1, bytes1),
    );
    if (!top && result.began) {
      const label = (i: 0 | 1) => o.labels[i] ?? [s0, s1][i].name;
      this.message(
        `diff${this.switches} ${headerName(label(0))} ${headerName(label(1))}\n`,
      );
    }
    this.out.push(result.out);
    if (result.err) this.err.push(result.err);
    return result.status;
  }

  private async compareLinks(s0: Side, s1: Side): Promise<number> {
    const targets: string[] = [];
    for (const side of [s0, s1]) {
      try {
        targets.push(await this.ctx.fs.readlink(this.path(side.name)));
      } catch (error) {
        rethrowFatalExecutionError(error);
        this.trouble(side.name, errorWords(error));
        return 2;
      }
    }
    if (targets[0] === targets[1]) return 0;
    this.message(
      `Symbolic links ${localeQuote(s0.name)} -> ${localeQuote(targets[0])} and ${localeQuote(s1.name)} -> ${localeQuote(targets[1])} differ\n`,
    );
    return 1;
  }

  /** Whether a directory of `pair` is one of its ancestors on that side. */
  private loops(pair: Pair, i: 0 | 1): boolean {
    const stat = pair.stats[i];
    if (stat === null) return false;
    for (let p = pair.parent; p !== null; p = p.parent) {
      const above = p.stats[i];
      if (above !== null && sameStat(above, stat)) return true;
    }
    return false;
  }

  private async diffDirs(pair: Pair): Promise<number> {
    this.traversal.visit(pair.depth);
    const none = [pair.stats[0] === null, pair.stats[1] === null];
    if ((none[0] || this.loops(pair, 0)) && (none[1] || this.loops(pair, 1))) {
      this.err.push(
        `diff: ${shellName(pair.names[none[0] ? 1 : 0])}: recursive directory loop\n`,
      );
      return 2;
    }
    const top = pair.parent === null;
    const start = top ? this.o.startingFile : null;
    // the first directories are read before GNU turns collation on
    const startOrder = this.o.ignoreFileNameCase
      ? caseOrder
      : this.collating
        ? this.order
        : byteOrder;
    let val = 0;
    const lists: string[][] = [[], []];
    for (const i of [0, 1] as const) {
      if (none[i]) continue;
      try {
        const names = await this.ctx.fs.readdir(this.path(pair.names[i]));
        this.traversal.discover(names.length);
        lists[i] = names.filter(
          (name) =>
            name !== "." &&
            name !== ".." &&
            (start === null || startOrder(name, start) >= 0) &&
            !this.excluded(name),
        );
      } catch (error) {
        rethrowFatalExecutionError(error);
        this.trouble(pair.names[i], errorWords(error));
        val = 2;
      }
    }
    if (val !== 0) return val;
    this.collating = this.collate;
    const [n0, n1] = lists;
    n0.sort(this.order);
    n1.sort(this.order);
    let i = 0;
    let j = 0;
    while (i < n0.length || j < n1.length) {
      const order =
        i >= n0.length ? 1 : j >= n1.length ? -1 : this.order(n0[i], n1[j]);
      if (order === 0 && this.o.ignoreFileNameCase) {
        preferExact(n0, i, n1, j);
      }
      const v = await this.compareFiles(
        pair,
        order > 0 ? null : n0[i++],
        order < 0 ? null : n1[j++],
      );
      if (v > val) val = v;
    }
    return val;
  }
}

/**
 * Among names equal but for case, pairs an exact match first, as GNU
 * does: the lesser of the two moves a later exact namesake forward.
 */
function preferExact(n0: string[], i: number, n1: string[], j: number): void {
  const raw = byteOrder(n0[i], n1[j]);
  if (raw === 0) return;
  const [lesser, at, greater] = raw < 0 ? [n0, i, n1[j]] : [n1, j, n0[i]];
  for (let p = at + 1; p < lesser.length; p++) {
    if (caseOrder(lesser[p], greater) !== 0) break;
    const c = byteOrder(lesser[p], greater);
    if (c >= 0) {
      if (c === 0) {
        const [exact] = lesser.splice(p, 1);
        lesser.splice(at, 0, exact);
      }
      break;
    }
  }
}
