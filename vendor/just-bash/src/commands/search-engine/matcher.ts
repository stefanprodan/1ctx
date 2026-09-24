/**
 * Core content matching logic for search commands
 */

import { utf8ByteLength } from "../../encoding.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import type { UserRegex } from "../../regex/index.js";
import type { PreFilter } from "./regex.js";

/**
 * Substring fast-path check: returns true if at least one needle is present
 * in the line, meaning the regex *might* match. False means provably no match.
 *
 * For case-insensitive filters, the line is lowercased once per call. Both the
 * needles and the line are compared in lowercase.
 */
function preFilterMatches(preFilter: PreFilter, line: string): boolean {
  const haystack = preFilter.ignoreCase ? line.toLowerCase() : line;
  const needles = preFilter.needles;
  for (let i = 0; i < needles.length; i++) {
    if (haystack.indexOf(needles[i]) !== -1) return true;
  }
  return false;
}

/**
 * Apply a replacement pattern using capture groups from a regex match
 * Supports: $& (full match), $1-$9 (numbered groups), $<name> (named groups)
 */
function applyReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(
    /\$(&|\d+|<([^>]+)>)/g,
    (_, ref: string, namedGroup: string | undefined) => {
      if (ref === "&") {
        return match[0];
      }
      if (namedGroup !== undefined) {
        // Named group: $<name>
        return match.groups?.[namedGroup] ?? "";
      }
      // Numbered group: $1, $2, etc.
      const groupNum = parseInt(ref, 10);
      return match[groupNum] ?? "";
    },
  );
}

export interface SearchOptions {
  /** Select non-matching lines */
  invertMatch?: boolean;
  /** Print line number with output lines */
  showLineNumbers?: boolean;
  /** Print only a count of matching lines */
  countOnly?: boolean;
  /** Count individual matches instead of lines (--count-matches) */
  countMatches?: boolean;
  /** Filename prefix for output (empty string for no prefix) */
  filename?: string;
  /** Show only the matching parts of lines */
  onlyMatching?: boolean;
  /** Print NUM lines of leading context */
  beforeContext?: number;
  /** Print NUM lines of trailing context */
  afterContext?: number;
  /**
   * (1ctx) Stop after NUM selected lines: undefined or negative is no
   * limit, 0 selects nothing
   */
  maxCount?: number;
  /** Separator between context groups (default: --); (1ctx) null for none */
  contextSeparator?: string | null;
  /**
   * (1ctx) Separate groups even with zero lines of context, as GNU grep
   * does when a context option was given
   */
  groupSeparators?: boolean;
  /** (1ctx) An earlier file printed lines, so a first group is separated */
  separateFirstGroup?: boolean;
  /** Show column number of first match */
  showColumn?: boolean;
  /** Output each match separately (vimgrep format) */
  vimgrep?: boolean;
  /** Show byte offset of each match */
  showByteOffset?: boolean;
  /** Replace matched text with this string */
  replace?: string | null;
  /** Print all lines (matches use :, non-matches use -) */
  passthru?: boolean;
  /** Enable multiline matching (patterns can span lines) */
  multiline?: boolean;
  /** If \K was used, this is the capture group index containing the "real" match */
  kResetGroup?: number;
  /** (1ctx) A match counts only with no word character on either side */
  wholeWord?: boolean;
  /** (1ctx) -o prints an empty line for an empty match, as ripgrep */
  printEmptyMatches?: boolean;
  /** (1ctx) -o still prints context lines whole, as ripgrep; GNU grep not */
  contextWithOnlyMatching?: boolean;
  /** (1ctx) -c with -o counts matches, as ripgrep; GNU grep counts lines */
  countOnlyMatching?: boolean;
  /** (1ctx) Written after the file name in place of : and - (grep -Z) */
  nameSeparator?: string;
  /** (1ctx) A tab after the line's head (grep -T) */
  initialTab?: boolean;
  /** (1ctx) What ends a line in and out: newline, or NUL for grep -z */
  lineTerminator?: string;
  /** (1ctx) Decide only whether and how often lines are selected */
  selectOnly?: boolean;
  /**
   * Optional substring fast-path: skip RE2 entirely for lines where no needle
   * is present. Pre-computed by buildRegex from the source pattern.
   */
  preFilter?: PreFilter | null;
  /** Maximum synchronous matching/formatting work units. */
  maxWork?: number;
  /** Maximum retained match objects. */
  maxMatches?: number;
  /** Cooperative cancellation signal checked during long scans. */
  signal?: AbortSignal;
}

export interface SearchResult {
  /** The formatted output string */
  output: string;
  /** Whether any matches were found */
  matched: boolean;
  /** Number of matches found */
  matchCount: number;
}

/** (1ctx) One match in a line, in UTF-16 offsets. */
interface Hit {
  /** the reported match: the \K or kept group when there is one */
  start: number;
  end: number;
  /** the whole match, where a replacement is read from */
  fullStart: number;
  fullEnd: number;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** (1ctx) The code point ending just before `index`, or "" at the start. */
function charBefore(line: string, index: number): string {
  if (index <= 0) return "";
  const low = line.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = line.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return line.slice(index - 2, index);
  }
  return line[index - 1];
}

/** (1ctx) The index one code point after `index`. */
function nextIndex(line: string, index: number): number {
  const code = line.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < line.length) {
    const low = line.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return index + 2;
  }
  return index + 1;
}

function isWordBefore(line: string, index: number): boolean {
  const ch = charBefore(line, index);
  return ch !== "" && WORD_CHAR.test(ch);
}

function isWordAt(line: string, index: number): boolean {
  if (index >= line.length) return false;
  return WORD_CHAR.test(String.fromCodePoint(line.codePointAt(index) ?? 0));
}

/** (1ctx) No word character touches the span on either side. */
export function isWholeWord(line: string, start: number, end: number): boolean {
  return !isWordBefore(line, start) && !isWordAt(line, end);
}

/**
 * (1ctx) Finds matches in one line: the \K group, the -w check done in code
 * as GNU grep does (no word character on either side, a shorter match at
 * the same start tried before a later start), and RE2 never asked past the
 * end of the line.
 */
class LineMatcher {
  constructor(
    private readonly regex: UserRegex,
    private readonly keepGroup: number | undefined,
    private readonly wholeWord: boolean,
    private readonly charge: () => void,
  ) {}

  private raw(line: string, from: number): Hit | null {
    if (from > line.length) return null;
    this.charge();
    if (this.keepGroup === undefined) {
      const span = this.regex.scan(line, from);
      if (span === null) return null;
      return {
        start: span.start,
        end: span.end,
        fullStart: span.start,
        fullEnd: span.end,
      };
    }
    const spans = this.regex.groups(line, from);
    if (spans === null) return null;
    const kept = spans[this.keepGroup] ?? spans[0];
    const start = kept.start < 0 ? spans[0].end : kept.start;
    const end = kept.start < 0 ? spans[0].end : kept.end;
    return { start, end, fullStart: spans[0].start, fullEnd: spans[0].end };
  }

  find(line: string, from: number): Hit | null {
    if (!this.wholeWord) return this.raw(line, from);
    let pos = from;
    while (pos <= line.length) {
      const hit = this.raw(line, pos);
      if (hit === null) return null;
      const start = hit.start;
      if (!isWordBefore(line, start)) {
        if (!isWordAt(line, hit.end)) return hit;
        const shorter = this.shorter(line, hit);
        if (shorter !== null) return shorter;
      }
      // the next start with no word character before it
      pos = start < line.length ? nextIndex(line, start) : start + 1;
      while (pos <= line.length && isWordBefore(line, pos)) {
        pos = nextIndex(line, pos);
      }
    }
    return null;
  }

  /** The longest match at the same start that ends before a non-word character. */
  private shorter(line: string, hit: Hit): Hit | null {
    if (this.keepGroup !== undefined) return null;
    for (let k = hit.end - 1; k >= hit.start; k--) {
      if (isWordAt(line, k)) continue;
      const candidate = this.raw(line.slice(0, k), hit.start);
      if (candidate === null || candidate.start !== hit.start) return null;
      if (!isWordAt(line, candidate.end)) return candidate;
      k = candidate.end;
    }
    return null;
  }

  /**
   * Every match in the line in order. An empty match right where the last
   * one ended is skipped, and the search then moves one code point on.
   */
  *all(line: string): Generator<Hit> {
    let pos = 0;
    let lastEnd = -1;
    while (pos <= line.length) {
      const hit = this.find(line, pos);
      if (hit === null) return;
      const empty = hit.end === hit.start;
      if (!(empty && hit.start === lastEnd)) yield hit;
      lastEnd = hit.end;
      const resume = Math.max(hit.end, hit.start);
      pos =
        empty || resume <= pos
          ? resume < line.length
            ? nextIndex(line, resume)
            : resume + 1
          : resume;
    }
  }
}

/** (1ctx) UTF-8 byte offsets of positions in one line, walked forward. */
class ByteCounter {
  private index = 0;
  private bytes = 0;
  constructor(private readonly line: string) {}
  at(index: number): number {
    if (index < this.index) {
      this.index = 0;
      this.bytes = 0;
    }
    this.bytes += utf8ByteLength(this.line.slice(this.index, index));
    this.index = index;
    return this.bytes;
  }
}

/**
 * Search content for regex matches and format output
 *
 * Handles:
 * - Count only mode (-c)
 * - Line numbers (-n)
 * - Invert match (-v)
 * - Only matching (-o)
 * - Context lines (-A, -B, -C)
 * - Max count (-m)
 */
export function searchContent(
  content: string,
  regex: UserRegex,
  options: SearchOptions = {},
): SearchResult {
  const {
    invertMatch = false,
    showLineNumbers = false,
    countOnly = false,
    countMatches = false,
    filename = "",
    onlyMatching = false,
    beforeContext = 0,
    afterContext = 0,
    maxCount,
    contextSeparator = "--",
    groupSeparators = beforeContext > 0 || afterContext > 0,
    separateFirstGroup = false,
    showColumn = false,
    vimgrep = false,
    showByteOffset = false,
    replace = null,
    passthru = false,
    multiline = false,
    kResetGroup,
    wholeWord = false,
    printEmptyMatches = false,
    contextWithOnlyMatching = false,
    countOnlyMatching = false,
    nameSeparator,
    initialTab = false,
    lineTerminator = "\n",
    selectOnly = false,
    preFilter,
    maxWork,
    maxMatches,
    signal,
  } = options;

  // (1ctx) -m 0 selects nothing
  const limit =
    maxCount === undefined || !(maxCount >= 0)
      ? Number.POSITIVE_INFINITY
      : maxCount;
  if (limit === 0) return { output: "", matched: false, matchCount: 0 };

  // Multiline mode: search entire content as one string
  if (multiline) {
    return searchContentMultiline(content, regex, {
      invertMatch,
      showLineNumbers,
      countOnly,
      countMatches,
      filename,
      onlyMatching,
      beforeContext,
      afterContext,
      maxCount: limit,
      contextSeparator,
      showColumn,
      showByteOffset,
      replace,
      kResetGroup,
      preFilter,
      maxWork,
      maxMatches,
      signal,
    });
  }

  let work = 0;
  const chargeWork = (amount = 1): void => {
    if (signal?.aborted) throw new ExecutionAbortedError();
    work += amount;
    if (maxWork !== undefined && work > maxWork) {
      throw new ExecutionLimitError(
        `search: matching work limit exceeded (${maxWork})`,
        "iterations",
      );
    }
  };
  const outputLines: string[] = [];
  const pushOutput = (value: string): void => {
    if (maxMatches !== undefined && outputLines.length >= maxMatches) {
      throw new ExecutionLimitError(
        `search: result limit exceeded (${maxMatches})`,
        "array_elements",
      );
    }
    outputLines.push(value);
  };

  const counting = countOnly || countMatches;
  const countResult = (count: number): SearchResult => {
    const name = filename ? `${filename}${nameSeparator ?? ":"}` : "";
    return {
      output: `${name}${count}\n`,
      matched: count > 0,
      matchCount: count,
    };
  };

  // File-level fast path: no needle anywhere means no line can match.
  if (preFilter && !invertMatch && !preFilterMatches(preFilter, content)) {
    return counting
      ? countResult(0)
      : { output: "", matched: false, matchCount: 0 };
  }

  let prospectiveLineCount = 1;
  const terminatorCode = lineTerminator.charCodeAt(0);
  for (let index = 0; index < content.length; index++) {
    if ((index & 1023) === 0) chargeWork();
    if (content.charCodeAt(index) === terminatorCode) {
      prospectiveLineCount++;
      if (maxMatches !== undefined && prospectiveLineCount > maxMatches) {
        throw new ExecutionLimitError(
          `search: line limit exceeded (${maxMatches})`,
          "array_elements",
        );
      }
    }
  }

  const lines = content.split(lineTerminator);
  const lineCount = lines.length;
  // Handle trailing empty line from split if content ended with newline
  const lastIdx =
    lineCount > 0 && lines[lineCount - 1] === "" ? lineCount - 1 : lineCount;

  const matcher = new LineMatcher(regex, kResetGroup, wholeWord, chargeWork);
  const lineMatches = (line: string): boolean => {
    if (preFilter && !preFilterMatches(preFilter, line)) return false;
    return matcher.find(line, 0) !== null;
  };
  const isSelected = (i: number): boolean => {
    chargeWork();
    return lineMatches(lines[i]) !== invertMatch;
  };

  // Count modes: selected lines, or with --count-matches their matches
  if (counting || selectOnly) {
    const perMatch = (countMatches || (onlyMatching && countOnlyMatching)) &&
      !invertMatch;
    let selected = 0;
    let count = 0;
    for (let i = 0; i < lastIdx && selected < limit; i++) {
      if (!isSelected(i)) continue;
      selected++;
      if (!counting) break;
      if (!perMatch) {
        count++;
        continue;
      }
      for (const _ of matcher.all(lines[i])) {
        chargeWork();
        count++;
      }
    }
    if (counting) return countResult(count);
    return { output: "", matched: selected > 0, matchCount: selected };
  }

  // Byte offsets are UTF-8, of the line's start or with -o the match's.
  const lineStarts: number[] = [];
  if (showByteOffset) {
    let offset = 0;
    for (let i = 0; i < lastIdx; i++) {
      lineStarts.push(offset);
      offset += utf8ByteLength(lines[i]) + utf8ByteLength(lineTerminator);
    }
  }

  const head = (i: number, sep: string, byte: number | null, col?: number) => {
    let prefix = "";
    if (filename) prefix += `${filename}${nameSeparator ?? sep}`;
    if (showLineNumbers) prefix += `${i + 1}${sep}`;
    if (col !== undefined) prefix += `${col}${sep}`;
    if (byte !== null) prefix += `${byte}${sep}`;
    if (initialTab && prefix !== "") prefix += "\t";
    return prefix;
  };

  const replaceHit = (line: string, hit: Hit, rep: string): string => {
    regex.lastIndex = hit.fullStart;
    const match = regex.exec(line);
    if (match === null) return rep;
    return applyReplacement(rep, match);
  };

  const printSelected = (i: number): void => {
    const line = lines[i];
    if (onlyMatching) {
      const bytes = new ByteCounter(line);
      for (const hit of matcher.all(line)) {
        chargeWork();
        if (hit.end === hit.start && !printEmptyMatches) continue;
        const text =
          replace !== null
            ? replaceHit(line, hit, replace)
            : line.slice(hit.start, hit.end);
        const byte = showByteOffset
          ? lineStarts[i] + bytes.at(hit.start)
          : null;
        const col = showColumn ? bytes.at(hit.start) + 1 : undefined;
        pushOutput(head(i, ":", byte, col) + text);
      }
      return;
    }
    const byte = showByteOffset ? lineStarts[i] : null;
    if (vimgrep) {
      const bytes = new ByteCounter(line);
      for (const hit of matcher.all(line)) {
        chargeWork();
        pushOutput(head(i, ":", byte, bytes.at(hit.start) + 1) + line);
      }
      return;
    }
    let text = line;
    let col: number | undefined;
    if ((showColumn || replace !== null) && !invertMatch) {
      const first = matcher.find(line, 0);
      if (showColumn) {
        col = first ? utf8ByteLength(line.slice(0, first.start)) + 1 : 1;
      }
      if (replace !== null) {
        let out = "";
        let last = 0;
        for (const hit of matcher.all(line)) {
          chargeWork();
          if (hit.end === hit.start && !printEmptyMatches) continue;
          out += line.slice(last, hit.start) + replaceHit(line, hit, replace);
          last = hit.end;
        }
        text = out + line.slice(last);
      }
    } else if (showColumn) {
      col = 1;
    }
    pushOutput(head(i, ":", byte, col) + text);
  };

  const printContext = (i: number): void => {
    if (onlyMatching && !contextWithOnlyMatching) return;
    const byte = showByteOffset ? lineStarts[i] : null;
    pushOutput(head(i, "-", byte, undefined) + lines[i]);
  };

  let matchCount = 0;

  // Passthru mode: print all lines, matches use :, non-matches use -
  if (passthru) {
    for (let i = 0; i < lastIdx; i++) {
      if (matchCount < limit && isSelected(i)) {
        matchCount++;
        printSelected(i);
      } else {
        printContext(i);
      }
    }
    return {
      output: joinOutput(outputLines, lineTerminator),
      matched: matchCount > 0,
      matchCount,
    };
  }

  // A selected line is always printed as one, even inside an earlier
  // line's after-context; context lines are placed as GNU grep places them.
  let lastPrinted = -1;
  let pendingAfter = 0;
  const separate = (start: number) => {
    if (!groupSeparators || contextSeparator === null) return;
    const gap =
      lastPrinted >= 0 ? start > lastPrinted + 1 : separateFirstGroup;
    if (gap) pushOutput(contextSeparator);
  };
  for (let i = 0; i < lastIdx; i++) {
    if (matchCount >= limit) {
      // after the last selected line, its after-context is printed as is
      if (pendingAfter <= 0) break;
      chargeWork();
      printContext(i);
      lastPrinted = i;
      pendingAfter--;
      continue;
    }
    if (isSelected(i)) {
      const start = Math.max(i - beforeContext, lastPrinted + 1);
      separate(start);
      for (let j = start; j < i; j++) {
        printContext(j);
        lastPrinted = j;
      }
      printSelected(i);
      lastPrinted = i;
      matchCount++;
      pendingAfter = afterContext;
    } else if (pendingAfter > 0) {
      printContext(i);
      lastPrinted = i;
      pendingAfter--;
    }
  }

  return {
    output: joinOutput(outputLines, lineTerminator),
    matched: matchCount > 0,
    matchCount,
  };
}

function joinOutput(lines: string[], terminator: string): string {
  if (lines.length === 0) return "";
  return `${lines.join(terminator)}${terminator}`;
}

/**
 * Multiline search - searches entire content as one string
 * Patterns can match across line boundaries (e.g., 'foo\nbar')
 */
function searchContentMultiline(
  content: string,
  regex: UserRegex,
  options: {
    invertMatch: boolean;
    showLineNumbers: boolean;
    countOnly: boolean;
    countMatches: boolean;
    filename: string;
    onlyMatching: boolean;
    beforeContext: number;
    afterContext: number;
    maxCount: number;
    contextSeparator: string | null;
    showColumn: boolean;
    showByteOffset: boolean;
    replace: string | null;
    kResetGroup?: number;
    preFilter?: PreFilter | null;
    maxWork?: number;
    maxMatches?: number;
    signal?: AbortSignal;
  },
): SearchResult {
  const {
    invertMatch,
    showLineNumbers,
    countOnly,
    countMatches,
    filename,
    onlyMatching,
    beforeContext,
    afterContext,
    maxCount,
    contextSeparator,
    showColumn,
    showByteOffset,
    replace,
    kResetGroup,
    preFilter,
    maxWork,
    maxMatches,
    signal,
  } = options;

  let work = 0;
  const chargeWork = (amount = 1): void => {
    if (signal?.aborted) throw new ExecutionAbortedError();
    work += amount;
    if (maxWork !== undefined && work > maxWork) {
      throw new ExecutionLimitError(
        `search: matching work limit exceeded (${maxWork})`,
        "iterations",
      );
    }
  };

  // File-level preFilter: if no needle appears anywhere in the content, no line can match.
  // Only safe when not inverting — an invert-match scan must check every line.
  if (preFilter && !invertMatch && !preFilterMatches(preFilter, content)) {
    if (countOnly || countMatches) {
      const countStr = filename ? `${filename}:0` : "0";
      return { output: `${countStr}\n`, matched: false, matchCount: 0 };
    }
    return { output: "", matched: false, matchCount: 0 };
  }

  // Build line offset map: lineOffsets[i] = byte offset where line i starts
  const lineOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if ((i & 1023) === 0) chargeWork();
    if (content[i] === "\n") {
      if (maxMatches !== undefined && lineOffsets.length >= maxMatches) {
        throw new ExecutionLimitError(
          `search: line index limit exceeded (${maxMatches})`,
          "array_elements",
        );
      }
      lineOffsets.push(i + 1);
    }
  }

  const lines = content.split("\n");
  const lineCount = lines.length;
  const lastIdx =
    lineCount > 0 && lines[lineCount - 1] === "" ? lineCount - 1 : lineCount;

  // Helper: convert byte offset to line number (0-indexed)
  const getLineIndex = (byteOffset: number): number => {
    let low = 0;
    let high = lineOffsets.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (lineOffsets[middle] <= byteOffset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return Math.max(0, low - 1);
  };

  // Helper: get column within line (1-indexed)
  const getColumn = (byteOffset: number): number => {
    const lineIdx = getLineIndex(byteOffset);
    return byteOffset - lineOffsets[lineIdx] + 1;
  };

  // Count modes do not need to retain every match. Regex matches are ordered
  // by start offset, so a single high-water mark is sufficient to count the
  // union of lines touched by matches without a potentially huge Set.
  if (countOnly || countMatches) {
    let individualMatchCount = 0;
    let matchedLineCount = 0;
    let lastMatchedLine = -1;

    regex.lastIndex = 0;
    for (
      let match = regex.exec(content);
      match !== null;
      match = regex.exec(content)
    ) {
      chargeWork();
      if (individualMatchCount >= maxCount) break;

      individualMatchCount++;
      if (!countMatches) {
        const startLine = getLineIndex(match.index);
        const endLine = getLineIndex(
          match.index + Math.max(0, match[0].length - 1),
        );
        const firstNewLine = Math.max(startLine, lastMatchedLine + 1);
        if (firstNewLine <= endLine) {
          matchedLineCount += endLine - firstNewLine + 1;
          lastMatchedLine = endLine;
        }
      }

      if (match[0].length === 0) regex.lastIndex++;
    }

    const matchCount = countMatches
      ? invertMatch
        ? 0
        : individualMatchCount
      : invertMatch
        ? lastIdx - matchedLineCount
        : matchedLineCount;
    const countStr = filename
      ? `${filename}:${matchCount}`
      : String(matchCount);
    return { output: `${countStr}\n`, matched: matchCount > 0, matchCount };
  }

  // First pass: find all match spans
  const matchSpans: Array<{
    startLine: number;
    endLine: number;
    byteOffset: number;
    column: number;
    matchText: string;
  }> = [];

  regex.lastIndex = 0;
  for (
    let match = regex.exec(content);
    match !== null;
    match = regex.exec(content)
  ) {
    chargeWork();
    if (matchSpans.length >= maxCount) break;
    if (maxMatches !== undefined && matchSpans.length >= maxMatches) {
      throw new ExecutionLimitError(
        `search: match limit exceeded (${maxMatches})`,
        "array_elements",
      );
    }

    const startLine = getLineIndex(match.index);
    const endLine = getLineIndex(
      match.index + Math.max(0, match[0].length - 1),
    );
    // If \K was used, extract from the capture group instead of full match
    const extractedMatch =
      kResetGroup !== undefined ? (match[kResetGroup] ?? "") : match[0];
    matchSpans.push({
      startLine,
      endLine,
      byteOffset: match.index,
      column: getColumn(match.index),
      matchText: extractedMatch,
    });

    // Prevent infinite loop on zero-length matches
    if (match[0].length === 0) regex.lastIndex++;
  }

  // Inverted match: output lines not part of any match
  if (invertMatch) {
    const matchedLines = new Set<number>();
    for (const span of matchSpans) {
      for (let i = span.startLine; i <= span.endLine; i++) {
        chargeWork();
        matchedLines.add(i);
      }
    }

    const outputLines: string[] = [];
    for (let i = 0; i < lastIdx; i++) {
      chargeWork();
      if (!matchedLines.has(i)) {
        let line = lines[i];
        if (showLineNumbers) line = `${i + 1}:${line}`;
        if (filename) line = `${filename}:${line}`;
        outputLines.push(line);
      }
    }

    return {
      output: outputLines.length > 0 ? `${outputLines.join("\n")}\n` : "",
      matched: outputLines.length > 0,
      matchCount: outputLines.length,
    };
  }

  // No matches found
  if (matchSpans.length === 0) {
    return { output: "", matched: false, matchCount: 0 };
  }

  // Output with context
  const printedLines = new Set<number>();
  let lastPrintedLine = -1;
  const outputLines: string[] = [];

  for (const span of matchSpans) {
    chargeWork();
    const contextStart = Math.max(0, span.startLine - beforeContext);
    const contextEnd = Math.min(lastIdx - 1, span.endLine + afterContext);

    // Add separator if there's a gap
    if (
      contextSeparator !== null &&
      lastPrintedLine >= 0 &&
      contextStart > lastPrintedLine + 1
    ) {
      outputLines.push(contextSeparator);
    }

    // Before context
    for (let i = contextStart; i < span.startLine; i++) {
      chargeWork();
      if (!printedLines.has(i)) {
        printedLines.add(i);
        lastPrintedLine = i;
        let line = lines[i];
        if (showLineNumbers) line = `${i + 1}-${line}`;
        if (filename) line = `${filename}-${line}`;
        outputLines.push(line);
      }
    }

    // Match lines
    if (onlyMatching) {
      // Output only the matched text
      const matchText = replace !== null ? replace : span.matchText;
      let prefix = filename ? `${filename}:` : "";
      if (showByteOffset) prefix += `${span.byteOffset}:`;
      if (showLineNumbers) prefix += `${span.startLine + 1}:`;
      if (showColumn) prefix += `${span.column}:`;
      outputLines.push(prefix + matchText);
      // Mark lines as printed to handle context correctly
      for (let i = span.startLine; i <= span.endLine; i++) {
        chargeWork();
        printedLines.add(i);
        lastPrintedLine = i;
      }
    } else {
      // Output full lines containing the match
      for (let i = span.startLine; i <= span.endLine && i < lastIdx; i++) {
        chargeWork();
        if (!printedLines.has(i)) {
          printedLines.add(i);
          lastPrintedLine = i;
          let line = lines[i];
          // Apply replacement if specified (for the first line of the match)
          if (replace !== null && i === span.startLine) {
            regex.lastIndex = 0;
            line = regex.replace(line, replace);
          }
          let prefix = filename ? `${filename}:` : "";
          if (showByteOffset && i === span.startLine)
            prefix += `${span.byteOffset}:`;
          if (showLineNumbers) prefix += `${i + 1}:`;
          if (showColumn && i === span.startLine) prefix += `${span.column}:`;
          outputLines.push(prefix + line);
        }
      }
    }

    // After context
    for (let i = span.endLine + 1; i <= contextEnd; i++) {
      chargeWork();
      if (!printedLines.has(i)) {
        printedLines.add(i);
        lastPrintedLine = i;
        let line = lines[i];
        if (showLineNumbers) line = `${i + 1}-${line}`;
        if (filename) line = `${filename}-${line}`;
        outputLines.push(line);
      }
    }
  }

  return {
    output: outputLines.length > 0 ? `${outputLines.join("\n")}\n` : "",
    matched: true,
    matchCount: matchSpans.length,
  };
}
