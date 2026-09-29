/**
 * (1ctx) diff's compare of two files it has read: the identical check on
 * the bytes, GNU's binary check, the lines interned after folding, the
 * engine, the ignorable changes and the chosen format. Pure but for the
 * work budget it charges.
 */

import { latin1FromBytes, encodeUtf8ToBytes } from "../../encoding.js";
import type { WorkBudget } from "./budget.js";
import { compare } from "./engine.js";
import { formatContext } from "./format-context.js";
import { formatNormal } from "./format-normal.js";
import { formatUnified } from "./format-unified.js";
import { headerName, headerTime, shellName } from "./header.js";
import { changesOf, hunksOf } from "./hunks.js";
import { folds, intern, splitLines } from "./lines.js";
import { contextLines, type DiffOptions } from "./options.js";
import { headings, type LineTest, markIgnorable } from "./patterns.js";

/** Steps a byte of folding and of regex matching are charged. */
const FOLD_STEPS = 8;
const MATCH_STEPS = 8;

export interface TextFile {
  name: string;
  bytes: string;
  mtime: Date;
  /** a NUL in this many first bytes makes it binary */
  window: number;
}

export interface Tests {
  /** -I */
  matching: LineTest | null;
  /** -p and -F */
  heading: LineTest | null;
}

export interface TextRun {
  o: DiffOptions;
  tests: Tests;
  budget: WorkBudget;
  tz: string | undefined;
}

export interface TextResult {
  /** the output's bytes, one character a byte */
  out: string;
  /** 0 the same, 1 different */
  status: number;
  /** GNU began the pair's output, which in a directory names the pair */
  began: boolean;
}

/** Text of our own, names included, as the output's bytes. */
export const text = (s: string) => latin1FromBytes(encodeUtf8ToBytes(s));

function isBinary(file: TextFile): boolean {
  const nul = file.bytes.indexOf("\0");
  return nul !== -1 && nul < file.window;
}

/** A file as diff's messages name it: its label, or its name quoted. */
export function messageName(o: DiffOptions, file: TextFile, i: 0 | 1): string {
  return o.labels[i] ?? shellName(file.name);
}

export function diffTexts(run: TextRun, a: TextFile, b: TextFile): TextResult {
  const { o, tests, budget } = run;
  const names = `${messageName(o, a, 0)} and ${messageName(o, b, 1)}`;
  const same: TextResult = { out: "", status: 0, began: false };
  const message = (words: string): TextResult => ({
    out: text(words),
    status: 1,
    began: false,
  });
  if (a.bytes === b.bytes) return same;
  if (!o.text && (isBinary(a) || isBinary(b))) {
    return message(
      o.brief ? `Files ${names} differ\n` : `Binary files ${names} differ\n`,
    );
  }
  const giveUp = budget.giveUp();
  const bytes = a.bytes.length + b.bytes.length;
  // splitting and interning take a step a byte, folding more
  budget.charge(folds(o) ? FOLD_STEPS * bytes : bytes);
  const la = splitLines(a.bytes, o.stripTrailingCr);
  const lb = splitLines(b.bytes, o.stripTrailingCr);
  const ids = intern(la, lb, o);
  const raw = folds(o) ? intern(la, lb, {}) : null;
  const charged = (test: LineTest | null): LineTest | null =>
    test &&
    ((line) => {
      budget.charge(MATCH_STEPS * (line.length + 1));
      return test(line);
    });
  const style = o.style ?? (o.showCFunction ? "context" : "normal");
  const context = style === "normal" ? 0 : contextLines(o);
  const comparison = compare(ids.a, ids.b, ids.count, {
    charge: budget.charge,
    giveUp,
    minimal: o.minimal,
    speedLargeFiles: o.speedLargeFiles,
    // the context shown is never left out of the search, as GNU keeps it
    horizon: Math.max(o.horizon, context),
    raw: raw ? [raw.a, raw.b] : undefined,
  });
  const changes = changesOf(comparison);
  if (o.ignoreBlankLines || tests.matching) {
    markIgnorable(
      changes,
      la,
      lb,
      o.ignoreBlankLines,
      o.ignoreAllSpace || o.ignoreSpaceChange || o.ignoreTrailingSpace,
      charged(tests.matching),
    );
  }
  const hunks = hunksOf(changes, context, la.lines.length, lb.lines.length);
  if (hunks.length === 0) return same;
  if (o.brief) return message(`Files ${names} differ\n`);

  const lineStyle = {
    initialTab: o.initialTab,
    suppressBlankEmpty: o.suppressBlankEmpty,
    expandTabs: o.expandTabs ? o.tabSize : 0,
  };
  const out: string[] = [];
  if (style === "normal") {
    formatNormal(la, lb, hunks, lineStyle, out);
    return { out: out.join(""), status: 1, began: true };
  }
  const heading = tests.heading
    ? headings(la, charged(tests.heading) as LineTest)
    : undefined;
  const header = (mark: string, file: TextFile, label: string | undefined) =>
    text(
      label !== undefined
        ? `${mark} ${label}\n`
        : `${mark} ${headerName(file.name)}\t${headerTime(file.mtime, run.tz)}\n`,
    );
  if (style === "unified") {
    out.push(header("---", a, o.labels[0]), header("+++", b, o.labels[1]));
    formatUnified(la, lb, hunks, lineStyle, out, heading);
  } else {
    out.push(header("***", a, o.labels[0]), header("---", b, o.labels[1]));
    formatContext(la, lb, hunks, lineStyle, out, heading);
  }
  return { out: out.join(""), status: 1, began: true };
}
