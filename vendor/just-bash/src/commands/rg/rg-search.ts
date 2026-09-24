/**
 * Core search logic for rg command
 */

import { gunzipSync } from "node:zlib";
import { BoundedStringBuilder } from "../../bounded-builder.js";
import {
  decodeBytesToUtf8,
  latin1FromBytes,
  readBytesFrom,
  unsafeBytesFromLatin1,
  utf8ByteLength,
} from "../../encoding.js";
import type { ResourceLease } from "../../execution-scope.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { FileTraversalBudget } from "../../fs/traversal.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import { createUserRegex, type UserRegex } from "../../regex/index.js";
import type { ExecResult, RuntimeCommandContext } from "../../types.js";
import {
  buildRegex,
  isWholeWord,
  type RegexResult,
  searchContent,
} from "../search-engine/index.js";
import { FileTypeRegistry } from "./file-types.js";
import { loadGitignores } from "./gitignore.js";
import { GlobError, Overrides } from "./globs.js";
import {
  type Collected,
  collectFiles,
  type Filters,
  type Haystack,
  STDIN_NAME,
} from "./rg-files.js";
import type { RgOptions } from "./rg-options.js";
import { compileReplacement } from "./replace.js";

/**
 * Check if data is gzip compressed (magic bytes)
 */
function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

export interface SearchContext {
  ctx: RuntimeCommandContext;
  options: RgOptions;
  paths: string[];
}

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
 * Execute the search with parsed options
 */
export async function executeSearch(
  searchCtx: SearchContext,
): Promise<ExecResult> {
  const { ctx, options, paths: inputPaths } = searchCtx;

  // (1ctx) one compiler for -g and --iglob, refusing a broken glob
  const overrides = new Overrides();
  for (const [glob, caseInsensitive] of [
    ...options.globs.map((g) => [g, options.globCaseInsensitive] as const),
    ...options.iglobs.map((g) => [g, true] as const),
  ]) {
    try {
      overrides.add(glob, caseInsensitive);
    } catch (error) {
      if (!(error instanceof GlobError)) throw error;
      return {
        stdout: "",
        stderr: `rg: error parsing glob '${glob}': ${error.message}\n`,
        exitCode: 2,
      };
    }
  }
  const filters = await makeFilters(ctx, options, overrides);

  // In --files mode every operand is a path
  if (options.files) {
    return listFiles(ctx, inputPaths, filters);
  }

  if (options.patterns.length > ctx.limits.maxArrayElements) {
    throw new ExecutionLimitError(
      `rg: pattern limit exceeded (${ctx.limits.maxArrayElements})`,
      "iterations",
    );
  }

  // Combine -e patterns with patterns from files. Pattern-file source and its
  // decoded lines remain live until regex compilation completes, so keep a
  // conservative lease for every source and release all of them together.
  const patterns = options.patterns.slice();
  const patternSourceLeases: ResourceLease[] = [];
  let aggregatePatternInputBytes = 0;
  let regex: UserRegex;
  let kResetGroup: number | undefined;
  try {
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
          patternSourceLeases.push(lease);
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
          patternSourceLeases.push(reservePatternSource(ctx, contentBytes));
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

    if (patterns.length === 0) {
      // If patterns came from files but all were empty, return no-match (exit 1)
      // Otherwise return error for no pattern given (exit 2)
      if (options.patternFiles.length > 0) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      return {
        stdout: "",
        stderr: "rg: no pattern given\n",
        exitCode: 2,
      };
    }

    // (1ctx) ripgrep refuses a newline without -U rather than miss it
    if (
      !options.multiline &&
      patterns.some((p) => hasNewline(p, options.fixedStrings))
    ) {
      return { stdout: "", stderr: NEWLINE_REFUSED, exitCode: 2 };
    }

    // Determine case sensitivity and compile while pattern storage is leased.
    const effectiveIgnoreCase = determineIgnoreCase(options, patterns);
    try {
      const regexResult = buildSearchRegex(
        patterns,
        options,
        effectiveIgnoreCase,
      );
      regex = regexResult.regex;
      kResetGroup = regexResult.kResetGroup;
    } catch {
      return {
        stdout: "",
        stderr: `rg: invalid regex: ${patterns.join(", ")}\n`,
        exitCode: 2,
      };
    }
  } finally {
    for (const lease of patternSourceLeases) lease.release();
  }

  // (1ctx) stdin when no path is given and something was piped, else the
  // directory; `-` is stdin among the paths
  const implicit = inputPaths.length === 0;
  const collected: Collected =
    implicit &&
    !options.patternFiles.includes("-") &&
    latin1FromBytes(ctx.stdin).length > 0
      ? {
          files: [{ path: STDIN_NAME, stdin: true, given: true }],
          named: false,
          errors: [],
        }
      : await collectFiles(ctx, inputPaths, filters, implicit);

  if (implicit && collected.files.length === 0) {
    return { stdout: "", stderr: NOTHING_SEARCHED, exitCode: 2 };
  }

  // file names when searching a directory or more than one path
  const showFilename =
    !options.noFilename && (options.withFilename || collected.named);

  const result = await searchFiles(
    ctx,
    collected.files,
    regex,
    options,
    showFilename,
    kResetGroup,
  );
  return withErrors(result, collected.errors, options.quiet);
}

const NEWLINE_REFUSED = `rg: the literal "\\n" is not allowed in a regex

Consider enabling multiline mode with the --multiline flag (or -U for short).
When multiline mode is enabled, new line characters can be matched.
`;

const NOTHING_SEARCHED = `rg: No files were searched, which means ripgrep probably applied a filter you didn't expect.
Running with --debug will show why files are being skipped.
`;

/** (1ctx) A newline in the pattern, typed or as `\n`. */
function hasNewline(pattern: string, fixed: boolean): boolean {
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
 * (1ctx) A missing path is reported and the others searched; the run
 * then exits 2, but for -q once a match was found.
 */
function withErrors(
  result: ExecResult,
  errors: string[],
  quiet: boolean,
): ExecResult {
  if (errors.length === 0) return result;
  return {
    ...result,
    stderr: `${errors.join("\n")}\n${result.stderr}`,
    exitCode: quiet && result.exitCode === 0 ? 0 : 2,
  };
}

async function makeFilters(
  ctx: RuntimeCommandContext,
  options: RgOptions,
  overrides: Overrides,
): Promise<Filters> {
  const gitignore = options.noIgnore
    ? null
    : await loadGitignores(
        ctx.fs,
        ctx.cwd,
        options.noIgnoreDot,
        options.noIgnoreVcs,
        options.ignoreFiles,
      );
  // Create file type registry and apply --type-clear and --type-add
  const types = new FileTypeRegistry();
  for (const name of options.typeClear) types.clearType(name);
  for (const spec of options.typeAdd) types.addType(spec);
  return { options, gitignore, types, overrides };
}

/**
 * List files that would be searched (--files mode)
 */
async function listFiles(
  ctx: RuntimeCommandContext,
  inputPaths: string[],
  filters: Filters,
): Promise<ExecResult> {
  const { files, errors } = await collectFiles(
    ctx,
    inputPaths,
    filters,
    inputPaths.length === 0,
  );
  const listed = files.filter((file) => !file.stdin);
  if (filters.options.quiet) {
    return withErrors(
      { stdout: "", stderr: "", exitCode: listed.length > 0 ? 0 : 1 },
      errors,
      true,
    );
  }
  const sep = filters.options.nullSeparator ? "\0" : "\n";
  const output = new BoundedStringBuilder(
    Math.min(ctx.limits.maxOutputSize, ctx.limits.maxStringLength),
    "rg",
  );
  for (const file of listed) output.append(file.path).append(sep);
  return withErrors(
    { stdout: output.build(), stderr: "", exitCode: listed.length > 0 ? 0 : 1 },
    errors,
    false,
  );
}

/**
 * Determine effective case sensitivity based on options
 */
function determineIgnoreCase(options: RgOptions, patterns: string[]): boolean {
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
function buildSearchRegex(
  patterns: string[],
  options: RgOptions,
  ignoreCase: boolean,
): RegexResult {
  let combinedPattern: string;
  if (patterns.length === 1) {
    combinedPattern = patterns[0];
  } else {
    combinedPattern = patterns
      .map((p) =>
        options.fixedStrings
          ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          : `(?:${p})`,
      )
      .join("|");
  }

  return buildRegex(combinedPattern, {
    mode: options.fixedStrings && patterns.length === 1 ? "fixed" : "perl",
    ignoreCase,
    wholeWord: options.wordRegexp,
    lineRegexp: options.lineRegexp,
    multiline: options.multiline,
    multilineDotall: options.multilineDotall,
  });
}

/**
 * Simple glob matching
 */
function matchGlob(str: string, pattern: string, ignoreCase = false): boolean {
  let regexStr = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*";
        i++;
      } else {
        regexStr += "[^/]*";
      }
    } else if (char === "?") {
      regexStr += "[^/]";
    } else if (char === "[") {
      let j = i + 1;
      if (j < pattern.length && pattern[j] === "!") j++;
      if (j < pattern.length && pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j < pattern.length) {
        let charClass = pattern.slice(i, j + 1);
        if (charClass.startsWith("[!")) {
          charClass = `[^${charClass.slice(2)}`;
        }
        regexStr += charClass;
        i = j;
      } else {
        regexStr += "\\[";
      }
    } else {
      regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regexStr += "$";

  return createUserRegex(regexStr, ignoreCase ? "i" : "").test(str);
}

/**
 * Check if a file matches any pre-glob patterns
 */
function matchesPreGlob(filename: string, preGlobs: string[]): boolean {
  if (preGlobs.length === 0) return true; // No patterns = match all

  for (const glob of preGlobs) {
    if (matchGlob(filename, glob, false)) {
      return true;
    }
  }
  return false;
}

/**
 * Read file content, handling preprocessing and gzip decompression if needed
 */
/** (1ctx) Standard input, searched as a file named `<stdin>`. */
function readStdin(ctx: RuntimeCommandContext): {
  content: string;
  isBinary: boolean;
  lease?: ResourceLease;
} {
  const content = decodeBytesToUtf8(ctx.stdin);
  return { content, isBinary: content.slice(0, 8192).includes("\0") };
}

async function readFileContent(
  ctx: RuntimeCommandContext,
  filePath: string,
  file: string,
  options: RgOptions,
): Promise<{
  content: string;
  isBinary: boolean;
  lease?: ResourceLease;
} | null> {
  let lease: ResourceLease | undefined;
  try {
    // Check for preprocessing with --pre
    if (options.preprocessor && ctx.exec) {
      const filename = file.split("/").pop() || file;
      if (matchesPreGlob(filename, options.preprocessorGlobs)) {
        // Run preprocessor on this file
        const result = await ctx.exec(shellJoinArgs([options.preprocessor]), {
          cwd: ctx.cwd,
          signal: ctx.signal,
          args: [filePath],
        });
        if (result.exitCode === 0 && result.stdout) {
          // Preprocessor output arrives as a latin1 byte buffer in the
          // pipeline; decode for regex matching. Empty output falls through.
          lease = ctx.executionScope?.reserveBytes(
            "rg preprocessor text",
            result.stdout.length,
            "rg preprocessor",
          );
          const content = decodeBytesToUtf8(
            unsafeBytesFromLatin1(result.stdout),
          );
          ctx.executionScope?.consumeInput(
            utf8ByteLength(content),
            "rg preprocessor",
          );
          const sample = content.slice(0, 8192);
          return { content, isBinary: sample.includes("\0"), lease };
        }
        // Preprocessing failed, fall through to normal file read
      }
    }

    // For -z option, try to decompress gzip files
    if (options.searchZip && file.endsWith(".gz")) {
      const stat = await ctx.fs.stat(filePath);
      const inputLease = ctx.executionScope?.reserveBytes(
        "rg compressed input",
        stat.size,
        "rg",
      );
      const buffer = await ctx.fs.readFileBuffer(filePath);
      if (buffer.byteLength > stat.size) {
        inputLease?.release();
        throw new ExecutionLimitError(
          "rg: file grew while being read",
          "string_length",
        );
      }
      ctx.executionScope?.consumeInput(buffer.byteLength, "rg");
      if (isGzip(buffer)) {
        let outputLease: ResourceLease | undefined;
        try {
          // The decoded string can coexist with zlib's output buffer. Reserve
          // both before invoking the whole-buffer codec.
          const outputCapacity = Math.min(
            ctx.limits.maxStringLength,
            ctx.limits.maxOutputSize,
            Math.floor(
              (ctx.executionScope?.remainingLiveBytes ??
                ctx.limits.maxLiveBytes) / 2,
            ),
          );
          outputLease = ctx.executionScope?.reserveBytes(
            "rg decompressed text",
            outputCapacity * 2,
            "rg",
          );
          // @banned-pattern-ignore: zlib maxOutputLength is derived from resolved execution byte limits
          const decompressed = gunzipSync(buffer, {
            maxOutputLength: outputCapacity,
          });
          const content = new TextDecoder().decode(decompressed);
          const sample = content.slice(0, 8192);
          return {
            content,
            isBinary: sample.includes("\0"),
            lease: compositeLease(inputLease, outputLease),
          };
        } catch (error) {
          outputLease?.release();
          inputLease?.release();
          rethrowFatalExecutionError(error);
          return null; // Decompression failed
        }
      }
      inputLease?.release();
    }

    // Regular file read
    const stat = await ctx.fs.stat(filePath);
    // A filesystem read can transiently retain its byte buffer while creating
    // the decoded string, so account for both representations prospectively.
    lease = ctx.executionScope?.reserveBytes(
      "rg file text",
      stat.size * 2,
      "rg",
    );
    const rawContent = await readBytesFrom(ctx.fs, filePath);
    const contentBytes = latin1FromBytes(rawContent).length;
    if (contentBytes > stat.size) {
      throw new ExecutionLimitError(
        "rg: file grew while being read",
        "string_length",
      );
    }
    ctx.executionScope?.consumeInput(contentBytes, "rg");
    const content = decodeBytesToUtf8(rawContent, ctx.limits.maxStringLength);
    const sample = content.slice(0, 8192);
    return { content, isBinary: sample.includes("\0"), lease };
  } catch (error) {
    lease?.release();
    rethrowFatalExecutionError(error);
    return null;
  }
}

function compositeLease(
  ...leases: Array<ResourceLease | undefined>
): ResourceLease | undefined {
  const active = leases.filter(
    (item): item is ResourceLease => item !== undefined,
  );
  if (active.length === 0) return undefined;
  return {
    release: () => {
      for (const item of active) item.release();
    },
  };
}

/**
 * Format a single match for JSON output
 */
interface JsonSubmatch {
  match: { text: string };
  start: number;
  end: number;
  replacement?: { text: string };
}

interface JsonMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    absolute_offset: number;
    submatches: JsonSubmatch[];
  };
}

/**
 * Search files and produce output
 */
async function searchFiles(
  ctx: RuntimeCommandContext,
  haystacks: Haystack[],
  regex: UserRegex,
  options: RgOptions,
  showFilename: boolean,
  kResetGroup?: number,
): Promise<ExecResult> {
  const files = haystacks.map((file) => file.path);
  const expand =
    options.replace !== null ? compileReplacement(options.replace) : undefined;
  let stdout = "";
  let anyMatch = false;

  // JSON mode tracking
  const jsonMessages: string[] = [];
  let totalMatches = 0;
  let filesWithMatch = 0;
  let bytesSearched = 0;

  // Compressed files retain both the decompressed byte buffer and decoded
  // string while being searched. Keep their concurrency deliberately small.
  const BATCH_SIZE = options.searchZip ? 2 : 50;
  outer: for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = haystacks.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (haystack) => {
        const file = haystack.path;
        const fileData = haystack.stdin
          ? readStdin(ctx)
          : await readFileContent(
              ctx,
              ctx.fs.resolvePath(ctx.cwd, file),
              file,
              options,
            );

        if (!fileData) return null;

        const { content, isBinary, lease } = fileData;
        bytesSearched += content.length;

        // Skip binary files found in a walk unless -a/--text is specified.
        if (isBinary && !options.searchBinary && !haystack.given) {
          lease?.release();
          return null;
        }

        const filenameForSearch = showFilename && !options.heading ? file : "";
        try {
          const result = searchContent(content, regex, {
            invertMatch: options.invertMatch,
            showLineNumbers: options.lineNumber,
            countOnly: options.count,
            countMatches: options.countMatches,
            filename: filenameForSearch,
            onlyMatching: options.onlyMatching,
            beforeContext: options.beforeContext,
            afterContext: options.afterContext,
            maxCount: options.maxCount,
            contextSeparator: options.contextSeparator,
            // (1ctx) ripgrep's field separators and replacement syntax
            fieldSeparators: {
              match: options.fieldMatchSeparator,
              context: options.fieldContextSeparator,
            },
            showColumn: options.column,
            vimgrep: options.vimgrep,
            showByteOffset: options.byteOffset,
            replace: options.replace,
            expand,
            passthru: options.passthru,
            multiline: options.multiline,
            kResetGroup,
            // (1ctx) the word check, -c -o and empty -o matches, as ripgrep
            wholeWord: options.wordRegexp,
            countOnlyMatching: true,
            printEmptyMatches: true,
            contextWithOnlyMatching: true,
            maxWork: ctx.limits.maxLoopIterations,
            maxMatches: ctx.limits.maxArrayElements,
            signal: ctx.signal,
          });

          // (1ctx) a binary file given by name reports that it matched
          if (
            isBinary &&
            !options.searchBinary &&
            result.matched &&
            !options.count &&
            !options.countMatches
          ) {
            const offset = utf8ByteLength(content.slice(0, content.indexOf("\0")));
            const name = showFilename ? `${file}: ` : "";
            result.output = `${name}binary file matches (found "\\0" byte around offset ${offset})\n`;
          }

          // JSON formatting below needs the source after this task ends, so
          // transfer lease ownership with the returned batch item.
          if (options.json && result.matched) {
            return { file, result, content, isBinary: false, lease };
          }

          lease?.release();
          return { file, result };
        } catch (error) {
          lease?.release();
          throw error;
        }
      }),
    );

    for (const res of results) {
      if (!res) continue;

      const { file, result } = res;

      if (result.matched) {
        anyMatch = true;
        filesWithMatch++;
        totalMatches += result.matchCount;

        if (options.quiet && !options.json) {
          // Quiet mode without JSON: exit early on first match
          break outer;
        }

        if (options.json && !options.quiet) {
          // JSON mode without quiet: output begin/match/end messages
          const content = (res as { content?: string }).content || "";
          jsonMessages.push(
            JSON.stringify({ type: "begin", data: { path: { text: file } } }),
          );

          // Find matches and output them
          const lines = content.split("\n");
          regex.lastIndex = 0;
          let lineOffset = 0;
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            regex.lastIndex = 0;
            const submatches: JsonSubmatch[] = [];

            for (
              let match = regex.exec(line);
              match !== null;
              match = regex.exec(line)
            ) {
              // (1ctx) -w is the matcher's check, not the pattern's
              if (
                options.wordRegexp &&
                !isWholeWord(line, match.index, match.index + match[0].length)
              ) {
                continue;
              }
              const submatch: JsonSubmatch = {
                match: { text: match[0] },
                start: match.index,
                end: match.index + match[0].length,
              };
              if (options.replace !== null) {
                submatch.replacement = { text: options.replace };
              }
              submatches.push(submatch);
              if (match[0].length === 0) regex.lastIndex++;
            }

            if (submatches.length > 0) {
              const matchMsg: JsonMatch = {
                type: "match",
                data: {
                  path: { text: file },
                  lines: { text: `${line}\n` },
                  line_number: lineIdx + 1,
                  absolute_offset: lineOffset,
                  submatches,
                },
              };
              jsonMessages.push(JSON.stringify(matchMsg));
            }
            lineOffset += line.length + 1;
          }

          jsonMessages.push(
            JSON.stringify({
              type: "end",
              data: {
                path: { text: file },
                binary_offset: null,
                stats: {
                  elapsed: { secs: 0, nanos: 0, human: "0s" },
                  searches: 1,
                  searches_with_match: 1,
                  bytes_searched: content.length,
                  bytes_printed: 0,
                  matched_lines: result.matchCount,
                  matches: result.matchCount,
                },
              },
            }),
          );
        } else if (options.filesWithMatches) {
          const sep = options.nullSeparator ? "\0" : "\n";
          stdout += `${file}${sep}`;
        } else if (!options.filesWithoutMatch) {
          // In heading mode, always show filename header (even for single files)
          if (options.heading && !options.noFilename) {
            stdout += `${file}\n`;
          } else if (
            // (1ctx) the context separator also parts files
            stdout !== "" &&
            result.output !== "" &&
            options.contextSeparator !== null &&
            (options.beforeContext > 0 || options.afterContext > 0) &&
            !options.count &&
            !options.countMatches
          ) {
            stdout += `${options.contextSeparator}\n`;
          }
          stdout += result.output;
        }
      } else if (options.filesWithoutMatch) {
        const sep = options.nullSeparator ? "\0" : "\n";
        stdout += `${file}${sep}`;
      } else if (
        options.includeZero &&
        (options.count || options.countMatches)
      ) {
        stdout += result.output;
      }
      (res as { lease?: ResourceLease }).lease?.release();
    }
  }

  // Finalize JSON output
  if (options.json) {
    jsonMessages.push(
      JSON.stringify({
        type: "summary",
        data: {
          elapsed_total: { secs: 0, nanos: 0, human: "0s" },
          stats: {
            elapsed: { secs: 0, nanos: 0, human: "0s" },
            searches: files.length,
            searches_with_match: filesWithMatch,
            bytes_searched: bytesSearched,
            bytes_printed: 0,
            matched_lines: totalMatches,
            matches: totalMatches,
          },
        },
      }),
    );
    stdout = `${jsonMessages.join("\n")}\n`;
  }

  // In JSON + quiet mode, output only the summary (already built above)
  // In non-JSON quiet mode, output nothing
  let finalStdout = options.quiet && !options.json ? "" : stdout;

  // Add stats output if requested
  if (options.stats && !options.json) {
    const statsOutput = [
      "",
      `${totalMatches} matches`,
      `${totalMatches} matched lines`,
      `${filesWithMatch} files contained matches`,
      `${files.length} files searched`,
      `${bytesSearched} bytes searched`,
    ].join("\n");
    finalStdout += `${statsOutput}\n`;
  }

  // Exit codes:
  // - For --files-without-match: 0 if files without matches found, 1 otherwise
  // - For normal mode: 0 if any matches found, 1 otherwise
  //
  // The --files-without-match rule below is NOT a copy of grep's and must not
  // be "fixed" to agree with it: ripgrep really does invert the status here,
  // where GNU grep does not. Measured with ripgrep 15.1.0 against GNU grep
  // 3.12, over two files where only the first contains the pattern:
  //
  //   both files match -> rg prints nothing, exits 1; grep -L exits 0
  //   neither matches  -> rg lists both,     exits 0; grep -L exits 1
  //   mixed            -> both list the miss and exit 0
  //
  // See the matching note in src/commands/grep/grep.ts.
  let exitCode: number;
  if (options.filesWithoutMatch) {
    // Success means we found files without matches (stdout has content)
    exitCode = stdout.length > 0 ? 0 : 1;
  } else {
    exitCode = anyMatch ? 0 : 1;
  }

  // rg emits text; the pipeline handles encoding.
  return {
    stdout: finalStdout,
    stderr: "",
    exitCode,
  };
}
