/**
 * (1ctx) rg's patterns, moved out of rg-search.ts: -e and the pattern
 * files of -f, whose text stays leased until the regex is built, and
 * the regex.
 */

import {
  decodeBytesToUtf8,
  latin1FromBytes,
  readBytesFrom,
} from "../../encoding.js";
import type { ResourceLease } from "../../execution-scope.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { ExecResult, RuntimeCommandContext } from "../../types.js";
import { buildPatterns, type RegexResult } from "../search-engine/index.js";
import type { RgOptions } from "./rg-options.js";

function reservePatternSource(
  ctx: RuntimeCommandContext,
  bytes: number,
): ResourceLease {
  // The raw bytes, decoded string, and retained per-line strings can coexist
  // until the combined regex is compiled. Reject prospectively before the
  // filesystem allocates any of them.
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > ctx.limits.maxStringLength ||
    bytes > Math.floor(ctx.limits.maxLiveBytes / 3)
  ) {
    throw new ExecutionLimitError(
      bytes > ctx.limits.maxStringLength
        ? `rg: pattern file exceeds string limit (${ctx.limits.maxStringLength} bytes)`
        : `rg: live byte limit exceeded (${ctx.limits.maxLiveBytes} bytes)`,
      "string_length",
    );
  }
  return (
    ctx.executionScope?.reserveBytes("rg pattern files", bytes * 3, "rg") ?? {
      release: () => undefined,
    }
  );
}

function appendPatternLines(
  patterns: string[],
  content: string,
  ctx: RuntimeCommandContext,
): void {
  let lineStart = 0;
  for (let index = 0; index <= content.length; index++) {
    if (index < content.length && content.charCodeAt(index) !== 10) continue;
    // (1ctx) a blank line is the empty pattern; only the last newline ends
    if (index < content.length || index > lineStart) {
      if (patterns.length >= ctx.limits.maxArrayElements) {
        throw new ExecutionLimitError(
          `rg: pattern limit exceeded (${ctx.limits.maxArrayElements})`,
          "iterations",
        );
      }
      ctx.executionScope?.consumeWork(1, "rg pattern insertion");
      patterns.push(content.slice(lineStart, index));
    }
    lineStart = index + 1;
  }
}

function accountPatternInput(
  ctx: RuntimeCommandContext,
  bytes: number,
  aggregateBytes: number,
): number {
  if (bytes > ctx.limits.maxInputBytes - aggregateBytes) {
    throw new ExecutionLimitError(
      `rg: aggregate input size limit exceeded (${ctx.limits.maxInputBytes} bytes)`,
      "string_length",
    );
  }
  ctx.executionScope?.consumeInput(bytes, "rg pattern files");
  return aggregateBytes + bytes;
}

/**
 * The patterns of -e and -f in order, with the leases a caller releases
 * once the regex is built, or the error ending the run.
 */
export async function loadPatterns(
  ctx: RuntimeCommandContext,
  options: RgOptions,
  leases: ResourceLease[],
): Promise<string[] | ExecResult> {
  if (options.patterns.length > ctx.limits.maxArrayElements) {
    throw new ExecutionLimitError(
      `rg: pattern limit exceeded (${ctx.limits.maxArrayElements})`,
      "iterations",
    );
  }
  const patterns = options.patterns.slice();
  let aggregatePatternInputBytes = 0;
  // Read patterns from files (-f/--file). Patterns are regex source — decode
  // bytes to UTF-8 so unicode-class patterns work. Scan incrementally instead
  // of split/filter/spread, which would create multiple unbounded arrays and
  // could overflow the argument stack on a large pattern file.
  for (const patternFile of options.patternFiles) {
    try {
      let rawContent: Parameters<typeof decodeBytesToUtf8>[0];
      let contentBytes: number;

      if (patternFile === "-") {
        rawContent = ctx.stdin;
        contentBytes = latin1FromBytes(ctx.stdin).length;
        aggregatePatternInputBytes = accountPatternInput(
          ctx,
          contentBytes,
          aggregatePatternInputBytes,
        );
      } else {
        const filePath = ctx.fs.resolvePath(ctx.cwd, patternFile);
        const stat = await ctx.fs.stat(filePath);
        contentBytes = stat.size;
        aggregatePatternInputBytes = accountPatternInput(
          ctx,
          contentBytes,
          aggregatePatternInputBytes,
        );
        const lease = reservePatternSource(ctx, contentBytes);
        leases.push(lease);
        rawContent = await readBytesFrom(ctx.fs, filePath);
        const actualBytes = latin1FromBytes(rawContent).length;
        if (actualBytes > contentBytes) {
          throw new ExecutionLimitError(
            "rg: pattern file grew while being read",
            "string_length",
          );
        }
        contentBytes = actualBytes;
      }

      if (patternFile === "-") {
        leases.push(reservePatternSource(ctx, contentBytes));
      }

      const content = decodeBytesToUtf8(
        rawContent,
        ctx.limits.maxStringLength,
      );
      ctx.executionScope?.consumeWork(
        content.length,
        "rg pattern file parsing",
      );
      appendPatternLines(patterns, content, ctx);
    } catch (error) {
      rethrowFatalExecutionError(error);
      return {
        stdout: "",
        stderr: `rg: ${patternFile}: No such file or directory\n`,
        exitCode: 2,
      };
    }
  }
  return patterns;
}

export const NEWLINE_REFUSED = `rg: the literal "\\n" is not allowed in a regex

Consider enabling multiline mode with the --multiline flag (or -U for short).
When multiline mode is enabled, new line characters can be matched.
`;

/** (1ctx) A newline in the pattern, typed or as `\n`. */
export function hasNewline(pattern: string, fixed: boolean): boolean {
  if (pattern.includes("\n")) return true;
  if (fixed) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue;
    if (pattern[i + 1] === "n") return true;
    i++;
  }
  return false;
}

/**
 * Determine effective case sensitivity based on options
 */
export function determineIgnoreCase(options: RgOptions, patterns: string[]): boolean {
  if (options.caseSensitive) {
    return false;
  }
  if (options.ignoreCase) {
    return true;
  }
  if (options.smartCase) {
    return !patterns.some((p) => /[A-Z]/.test(p));
  }
  return false;
}

/**
 * Build the search regex from patterns
 */
export function buildSearchRegex(
  patterns: string[],
  options: RgOptions,
  ignoreCase: boolean,
): RegexResult {
  const common = {
    ignoreCase,
    wholeWord: options.wordRegexp,
    lineRegexp: options.lineRegexp,
    multiline: options.multiline,
    multilineDotall: options.multilineDotall,
  };
  // (1ctx) -P through grep's -P layer: its rewrites and its refusals
  if (options.pcre && !options.fixedStrings) {
    return buildPatterns(patterns, { ...common, mode: "perl", pcre: true });
  }
  const combinedPattern =
    patterns.length === 1
      ? patterns[0]
      : patterns
          .map((p) =>
            options.fixedStrings
              ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              : `(?:${p})`,
          )
          .join("|");
  const fixed = options.fixedStrings && patterns.length === 1;
  return buildPatterns([combinedPattern], {
    ...common,
    mode: fixed ? "fixed" : "perl",
    // (1ctx) Rust's syntax: Unicode classes, \< and \>
    rust: fixed ? undefined : { unicode: options.unicode },
  });
}
