/**
 * Core search logic for rg command
 */

import { BoundedStringBuilder } from "../../bounded-builder.js";
import { latin1FromBytes, utf8ByteLength } from "../../encoding.js";
import type { ResourceLease } from "../../execution-scope.js";
import type { UserRegex } from "../../regex/index.js";
import type { ExecResult, RuntimeCommandContext } from "../../types.js";
import { GnuPatternError } from "../search-engine/gnu-regex.js";
import {
  type RegexResult,
  searchContent,
  type WordEdges,
} from "../search-engine/index.js";
import { FileTypeError, FileTypeRegistry } from "./file-types.js";
import { loadGitignores } from "./gitignore.js";
import { GlobError, Overrides } from "./globs.js";
import {
  type Collected,
  collectFiles,
  type Filters,
  type Haystack,
  STDIN_NAME,
} from "./rg-files.js";
import { fileMessages, summaryMessage } from "./rg-json.js";
import type { RgOptions } from "./rg-options.js";
import { lineDisplay, shownPath } from "./rg-output.js";
import {
  buildSearchRegex,
  determineIgnoreCase,
  hasNewline,
  loadPatterns,
  NEWLINE_REFUSED,
} from "./rg-patterns.js";
import { readFileContent, readStdin } from "./rg-read.js";
import { compileReplacement } from "./replace.js";

export interface SearchContext {
  ctx: RuntimeCommandContext;
  options: RgOptions;
  paths: string[];
}

function refused(message: string): ExecResult {
  return { stdout: "", stderr: `rg: ${message}\n`, exitCode: 2 };
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
      return refused(`error parsing glob '${glob}': ${error.message}`);
    }
  }
  // (1ctx) ripgrep's type table, the changes in order, a bad name refused
  const types = new FileTypeRegistry();
  try {
    for (const change of options.typeChanges) {
      if (change.kind === "add") types.addType(change.value);
      else types.clearType(change.value);
    }
    if (options.typeList) {
      return { stdout: types.format(), stderr: "", exitCode: 0 };
    }
    types.check(options.types);
    types.check(options.typesNot);
  } catch (error) {
    if (!(error instanceof FileTypeError)) throw error;
    return refused(error.message);
  }
  const filters = await makeFilters(ctx, options, overrides, types);

  // In --files mode every operand is a path
  if (options.files) {
    return listFiles(ctx, inputPaths, filters);
  }

  // Pattern-file source and its decoded lines remain live until regex
  // compilation completes, so every lease is released together after it.
  const leases: ResourceLease[] = [];
  let built: RegexResult;
  try {
    const patterns = await loadPatterns(ctx, options, leases);
    if (!Array.isArray(patterns)) return patterns;

    if (patterns.length === 0) {
      // If patterns came from files but all were empty, return no-match (exit 1)
      // Otherwise return error for no pattern given (exit 2)
      if (options.patternFiles.length > 0) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      return refused("no pattern given");
    }

    // (1ctx) ripgrep refuses a newline without -U rather than miss it
    if (
      !options.multiline &&
      patterns.some((p) => hasNewline(p, options.fixedStrings))
    ) {
      return { stdout: "", stderr: NEWLINE_REFUSED, exitCode: 2 };
    }

    try {
      built = buildSearchRegex(
        patterns,
        options,
        determineIgnoreCase(options, patterns),
      );
    } catch (error) {
      // (1ctx) -P's refusals name what RE2 cannot run
      if (error instanceof GnuPatternError) return refused(error.message);
      return refused(`invalid regex: ${patterns.join(", ")}`);
    }
  } finally {
    for (const lease of leases) lease.release();
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
    built,
    options,
    showFilename,
  );
  return withErrors(result, collected.errors, options);
}

const NOTHING_SEARCHED = `rg: No files were searched, which means ripgrep probably applied a filter you didn't expect.
Running with --debug will show why files are being skipped.
`;

/**
 * (1ctx) A missing path is reported and the others searched; the run
 * then exits 2, but for -q once a match was found. --no-messages keeps
 * the exit and drops the words.
 */
function withErrors(
  result: ExecResult,
  errors: string[],
  options: RgOptions,
): ExecResult {
  if (errors.length === 0) return result;
  const words = options.noMessages ? "" : `${errors.join("\n")}\n`;
  return {
    ...result,
    stderr: `${words}${result.stderr}`,
    exitCode: options.quiet && result.exitCode === 0 ? 0 : 2,
  };
}

async function makeFilters(
  ctx: RuntimeCommandContext,
  options: RgOptions,
  overrides: Overrides,
  types: FileTypeRegistry,
): Promise<Filters> {
  const gitignore = options.noIgnore
    ? null
    : await loadGitignores(ctx.fs, ctx.cwd, {
        skipDotIgnore: options.noIgnoreDot,
        skipVcsIgnore: options.noIgnoreVcs,
        customIgnoreFiles: options.noIgnoreFiles ? [] : options.ignoreFiles,
        noParents: options.noIgnoreParent,
        requireGit: options.requireGit,
      });
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
  const { options } = filters;
  if (options.quiet) {
    return withErrors(
      { stdout: "", stderr: "", exitCode: listed.length > 0 ? 0 : 1 },
      errors,
      options,
    );
  }
  const sep = options.nullSeparator ? "\0" : "\n";
  const output = new BoundedStringBuilder(
    Math.min(ctx.limits.maxOutputSize, ctx.limits.maxStringLength),
    "rg",
  );
  for (const file of listed) {
    output.append(shownPath(file.path, options)).append(sep);
  }
  return withErrors(
    { stdout: output.build(), stderr: "", exitCode: listed.length > 0 ? 0 : 1 },
    errors,
    options,
  );
}

/** (1ctx) Each file's own lines, before they are put together. */
interface Searched {
  file: string;
  output: string;
  matched: boolean;
  matchCount: number;
  lease?: ResourceLease;
  content?: string;
}

/**
 * Search files and produce output
 */
async function searchFiles(
  ctx: RuntimeCommandContext,
  haystacks: Haystack[],
  built: RegexResult,
  options: RgOptions,
  showFilename: boolean,
): Promise<ExecResult> {
  const regex: UserRegex = built.regex;
  const edges: WordEdges = {
    whole: options.wordRegexp,
    start: built.wordStart,
    end: built.wordEnd,
  };
  const expand =
    options.replace !== null ? compileReplacement(options.replace) : undefined;
  const display = lineDisplay(options);
  const counting = options.count || options.countMatches;
  const listing = options.filesWithMatches || options.filesWithoutMatch;
  // (1ctx) a file's lines under its name, only where names are shown
  const heading =
    options.heading &&
    showFilename &&
    !options.vimgrep &&
    !counting &&
    !listing &&
    !options.json;
  const nameEnd = options.nullSeparator ? "\0" : "\n";
  let stdout = "";
  let anyMatch = false;

  // JSON mode tracking
  const jsonMessages: string[] = [];
  let totalMatches = 0;
  let filesWithMatch = 0;
  let bytesSearched = 0;

  const searchOne = async (haystack: Haystack): Promise<Searched | null> => {
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

    // (1ctx) a binary file in a walk is skipped but under -a, --binary, -uuu
    if (
      isBinary &&
      !options.searchBinary &&
      !options.binary &&
      !haystack.given
    ) {
      lease?.release();
      return null;
    }

    const name = shownPath(file, options);
    // (1ctx) --vimgrep names the file whatever the defaults say
    const filename =
      options.vimgrep || (showFilename && !heading) ? name : "";
    try {
      const result = searchContent(content, regex, {
        invertMatch: options.invertMatch,
        showLineNumbers: options.lineNumber,
        countOnly: options.count,
        countMatches: options.countMatches,
        filename,
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
        nameSeparator: options.nullSeparator ? "\0" : undefined,
        showColumn: options.column,
        vimgrep: options.vimgrep,
        showByteOffset: options.byteOffset,
        replace: options.replace,
        expand,
        passthru: options.passthru,
        multiline: options.multiline,
        kResetGroup: built.kResetGroup,
        conditions: built.conditions,
        // (1ctx) the word checks, -c -o and empty -o matches, as ripgrep
        wholeWord: options.wordRegexp,
        wordStart: built.wordStart,
        wordEnd: built.wordEnd,
        crlf: options.crlf,
        display,
        countOnlyMatching: true,
        printEmptyMatches: true,
        contextWithOnlyMatching: true,
        maxWork: ctx.limits.maxLoopIterations,
        maxMatches: ctx.limits.maxArrayElements,
        signal: ctx.signal,
      });

      // (1ctx) a binary file searched whole reports that it matched
      if (isBinary && !options.searchBinary && result.matched && !counting) {
        const offset = utf8ByteLength(content.slice(0, content.indexOf("\0")));
        const prefix = showFilename ? `${name}: ` : "";
        result.output = `${prefix}binary file matches (found "\\0" byte around offset ${offset})\n`;
      }

      // JSON formatting below needs the source after this task ends, so
      // transfer lease ownership with the returned item.
      if (options.json && result.matched) {
        return { file, ...result, content, lease };
      }
      lease?.release();
      return { file, ...result };
    } catch (error) {
      lease?.release();
      throw error;
    }
  };

  // Compressed files retain both the decompressed byte buffer and decoded
  // string while being searched. Keep their concurrency deliberately small.
  const BATCH_SIZE = options.searchZip ? 2 : 50;
  outer: for (let i = 0; i < haystacks.length; i += BATCH_SIZE) {
    const batch = haystacks.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(searchOne));

    for (const res of results) {
      if (!res) continue;
      const name = shownPath(res.file, options);

      if (res.matched) {
        anyMatch = true;
        filesWithMatch++;
        totalMatches += res.matchCount;

        if (options.quiet && !options.json) {
          // Quiet mode without JSON: exit early on first match
          break outer;
        }

        if (options.json && !options.quiet) {
          jsonMessages.push(
            ...fileMessages(
              res.file,
              res.content ?? "",
              regex,
              edges,
              options.replace,
              res.matchCount,
            ),
          );
        } else if (options.filesWithMatches) {
          stdout += `${name}${nameEnd}`;
        } else if (!options.filesWithoutMatch) {
          if (heading) {
            // (1ctx) a blank line between files, ripgrep's heading
            if (stdout !== "") stdout += "\n";
            stdout += `${name}${nameEnd}`;
          } else if (
            // (1ctx) the context separator also parts files
            stdout !== "" &&
            res.output !== "" &&
            options.contextSeparator !== null &&
            (options.beforeContext > 0 || options.afterContext > 0) &&
            !counting
          ) {
            stdout += `${options.contextSeparator}\n`;
          }
          stdout += res.output;
        }
      } else if (options.filesWithoutMatch) {
        stdout += `${name}${nameEnd}`;
      } else if (options.includeZero && counting) {
        stdout += res.output;
      }
      res.lease?.release();
    }
  }

  // Finalize JSON output
  if (options.json) {
    jsonMessages.push(
      summaryMessage(
        haystacks.length,
        filesWithMatch,
        bytesSearched,
        totalMatches,
      ),
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
      `${haystacks.length} files searched`,
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
  return { stdout: finalStdout, stderr: "", exitCode };
}
