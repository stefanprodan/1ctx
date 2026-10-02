import { utf8ByteLength } from "../../encoding.js";
import { ExecutionOutputAccumulator } from "../../execution-output.js";
import type { ExecutionScope } from "../../execution-scope.js";
// (1ctx readonly-errors)
import {
  fsErrorCode,
  fsErrorWords,
  isReadOnlyError,
} from "../../fs/error-words.js";
import type { DirentEntry } from "../../fs/interface.js";
// (1ctx find-links) keep host paths out of unfamiliar link errors
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import { FileTraversalBudget } from "../../fs/traversal.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
  TraceCallback,
} from "../../types.js";
import { formatMode } from "../format-mode.js";

// Use a larger batch size for find to maximize parallel I/O
const FIND_BATCH_SIZE = 500;

/**
 * Wait for every node in a batch before failing on any of them.
 *
 * `Promise.all` rejects on the first failure and leaves the rest of the batch
 * running. Those siblings finish after `find` has returned, once the command's
 * execution has been deactivated, and the defense-in-depth box blocks the
 * rejection handler `Promise.all` attached to each of them and re-raises the
 * error on a promise nothing holds: one unhandled rejection per sibling, which
 * ends a Node process that has no handler. Waiting keeps every continuation
 * inside the execution that started it. The failure reported is the first in
 * traversal order. Upstream #451. (1ctx find-batch)
 */
async function settleBatch<T>(work: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(work);
  const values: T[] = [];
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
    values.push(result.value);
  }
  return values;
}

// Tracing helpers
interface TraceCounters {
  readdirCalls: number;
  readdirTime: number;
  statCalls: number;
  statTime: number;
  evalCalls: number;
  evalTime: number;
  nodeCount: number;
  batchCount: number;
  batchTime: number;
  earlyPrunes: number;
}

function createTraceCounters(): TraceCounters {
  return {
    readdirCalls: 0,
    readdirTime: 0,
    statCalls: 0,
    statTime: 0,
    evalCalls: 0,
    evalTime: 0,
    nodeCount: 0,
    batchCount: 0,
    batchTime: 0,
    earlyPrunes: 0,
  };
}

function emitTraceSummary(
  trace: TraceCallback,
  counters: TraceCounters,
  totalMs: number,
): void {
  trace({
    category: "find",
    name: "summary",
    durationMs: totalMs,
    details: {
      readdirCalls: counters.readdirCalls,
      readdirTimeMs: counters.readdirTime,
      statCalls: counters.statCalls,
      statTimeMs: counters.statTime,
      evalCalls: counters.evalCalls,
      evalTimeMs: counters.evalTime,
      nodeCount: counters.nodeCount,
      batchCount: counters.batchCount,
      batchTimeMs: counters.batchTime,
      earlyPrunes: counters.earlyPrunes,
      otherTimeMs:
        totalMs -
        counters.readdirTime -
        counters.statTime -
        counters.evalTime -
        counters.batchTime,
    },
  });
}

import { hasHelpFlag, showHelp } from "../help.js";
import {
  applyWidth,
  parseWidthPrecision,
  processEscapes,
} from "../printf/escapes.js";
import {
  collectNewerRefs,
  evaluateExpressionWithPrune,
  evaluateForEarlyPrune,
  evaluateLive,
  evaluateSimpleExpression,
  expressionHasPrune,
  expressionNeedsEmptyCheck,
  expressionNeedsStatMetadata,
  isSimpleExpression,
} from "./matcher.js";
import { execEnd, parseExpressions } from "./parser.js";
import type {
  EvalContext,
  EvalResult,
  Expression,
  FindAction,
} from "./types.js";

// (1ctx find-links) a missing target: -L then reads the link itself, as GNU does
function isMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ENOENT") || message.includes("no such file");
}

// (1ctx find-links) GNU's words for a link -L cannot read through
function statWords(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ELOOP")) return "Too many levels of symbolic links";
  if (message.includes("ENOTDIR")) return "Not a directory";
  if (message.includes("EACCES")) return "Permission denied";
  return sanitizeErrorMessage(message);
}

// (1ctx find-diagnostics) GNU find's C-locale quoting, not shell quoting.
function diagnosticPath(path: string): string {
  const escapes: Record<number, string> = {
    7: "\\a",
    8: "\\b",
    9: "\\t",
    10: "\\n",
    11: "\\v",
    12: "\\f",
    13: "\\r",
    39: "\\'",
    92: "\\\\",
  };
  let quoted = "'";
  for (const byte of new TextEncoder().encode(path)) {
    quoted +=
      escapes[byte] ??
      (byte < 32 || byte >= 127
        ? `\\${byte.toString(8).padStart(3, "0")}`
        : String.fromCharCode(byte));
  }
  return `${quoted}'`;
}

const findHelp = {
  name: "find",
  summary: "search for files in a directory hierarchy",
  // (1ctx find-links) advertise the supported link policies
  usage: "find [-H] [-L] [-P] [path...] [expression]",
  options: [
    "-P               never follow symbolic links (the default)",
    "-L               follow symbolic links",
    "-H               follow symbolic links only in the starting points",
    "-name PATTERN    file name matches shell pattern PATTERN",
    "-iname PATTERN   like -name but case insensitive",
    "-path PATTERN    file path matches shell pattern PATTERN",
    "-ipath PATTERN   like -path but case insensitive",
    "-regex PATTERN   file path matches regular expression PATTERN",
    "-iregex PATTERN  like -regex but case insensitive",
    "-type TYPE       file is of type: f (regular file), d (directory)",
    "-empty           file is empty or directory is empty",
    "-mtime N         file's data was modified N*24 hours ago",
    "-newer FILE      file was modified more recently than FILE",
    "-size N[ckMGb]   file uses N units of space (c=bytes, k=KB, M=MB, G=GB, b=512B blocks)",
    "-perm MODE       file's permission bits are exactly MODE (octal)",
    "-perm -MODE      all permission bits MODE are set",
    "-perm /MODE      any permission bits MODE are set",
    "-maxdepth LEVELS descend at most LEVELS directories",
    "-mindepth LEVELS do not apply tests at levels less than LEVELS",
    "-depth           process directory contents before directory itself",
    "-prune           do not descend into this directory",
    "-not, !          negate the following expression",
    "-a, -and         logical AND (default)",
    "-o, -or          logical OR",
    "-exec CMD {} ;   execute CMD on each file ({} is replaced by filename)",
    "-exec CMD {} +   execute CMD with multiple files at once",
    "-print           print the full file name (default action)",
    "-print0          print the full file name followed by a null character",
    "-printf FORMAT   print FORMAT with directives: %f %h %p %P %s %d %m %M %t",
    "-delete          delete found files/directories",
    "    --help       display this help and exit",
  ],
};

export const findCommand: RuntimeCommand = {
  name: "find",
  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(findHelp);
    }

    const searchPaths: string[] = [];
    let maxDepth: number | null = null;
    let minDepth: number | null = null;
    let depthFirst = false;

    // Starting points must precede the expression. Separating them first keeps
    // predicate operands and -exec command arguments from being mistaken for paths.
    // (1ctx find-links end-of-options) GNU's leading options: -H, -L and -P, the last one winning,
    // then an optional `--` ending them
    let follow: "H" | "L" | "P" = "P";
    let firstPath = 0;
    while (firstPath < args.length) {
      const arg = args[firstPath];
      if (arg === "-H" || arg === "-L" || arg === "-P") {
        follow = arg[1] as "H" | "L" | "P";
        firstPath++;
        continue;
      }
      if (arg === "--") firstPath++;
      break;
    }
    let expressionStart = args.length;
    for (let i = firstPath; i < args.length; i++) {
      const arg = args[i];
      if (
        arg.startsWith("-") ||
        arg === "(" ||
        arg === "\\(" ||
        arg === ")" ||
        arg === "\\)" ||
        arg === "!"
      ) {
        expressionStart = i;
        break;
      }
      searchPaths.push(arg);
    }

    // Default to current directory if no paths specified
    if (searchPaths.length === 0) {
      searchPaths.push(".");
    }

    // Validate traversal options before parsing or touching the filesystem.
    for (let i = expressionStart; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-exec") {
        // (1ctx find-exec) the parser's rule for where the command ends
        i = execEnd(args, i + 1);
      } else if (arg === "-maxdepth" || arg === "-mindepth") {
        const value = args[i + 1];
        if (value === undefined || !/^\d+$/.test(value)) {
          return {
            stdout: "",
            stderr:
              value === undefined
                ? `find: missing argument to \`${arg}'\n`
                : `find: invalid argument \`${value}' to \`${arg}'\n`,
            exitCode: 1,
          };
        }
        const depth = Number(value);
        if (!Number.isSafeInteger(depth)) {
          return {
            stdout: "",
            stderr: `find: invalid argument \`${value}' to \`${arg}'\n`,
            exitCode: 1,
          };
        }
        if (arg === "-maxdepth") maxDepth = depth;
        else minDepth = depth;
        i++;
      } else if (arg === "-depth") {
        depthFirst = true;
      }
    }

    // Parse the complete expression before any filesystem access or action.
    const { expr, error } = parseExpressions(args, expressionStart);

    // Return error for unknown predicates
    if (error) {
      return { stdout: "", stderr: error, exitCode: 1 };
    }

    const expressionActions = collectActions(expr);
    const hasAnyAction = expressionActions.length > 0;
    const hasDelete = expressionActions.some((a) => a.type === "delete");
    if (hasDelete) depthFirst = true;
    // (1ctx find-exec) `-exec ;` and `-delete` answer true or false and change
    // the tree, so they run in order as the walk reaches them; every other
    // expression keeps the batched walk
    const live =
      hasDelete ||
      expressionActions.some((a) => a.type === "exec" && !a.batchMode);
    if (!ctx.exec && expressionActions.some((a) => a.type === "exec")) {
      return {
        stdout: "",
        stderr: "find: -exec not supported in this context\n",
        exitCode: 1,
      };
    }

    // Result type for find entries
    interface FindResult {
      path: string;
      name: string;
      size: number;
      mtime: number;
      mode: number;
      isDirectory: boolean;
      depth: number;
      startingPoint: string;
    }

    // A directory the traversal could not read, carried as an effect of its
    // node so the message lands in traversal order beside the node's own
    // output, rather than in whatever order the parallel batch settled.
    // (1ctx find-diagnostics) a link find could not follow and a missing
    // starting point travel the same way, so each lands in GNU's order
    interface DiagnosticAction {
      type: "diagnostic";
      message: string;
    }

    interface EvaluatedEffect {
      action: FindAction | DiagnosticAction;
      path: string;
      printfData: FindResult;
    }
    const effects: EvaluatedEffect[] = [];
    let exitCode = 0;
    const output = ctx.executionScope
      ? new ExecutionOutputAccumulator(
          ctx.executionScope as ExecutionScope,
          "find",
        )
      : undefined;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let fallbackOutputBytes = 0;
    const traversalBudget = new FileTraversalBudget({
      limits: ctx.limits,
      signal: ctx.signal,
      executionScope: ctx.executionScope,
      site: "find",
    });
    const appendStdout = (value: string): void => {
      if (output) output.append("stdout", value);
      else {
        const bytes = utf8ByteLength(value);
        if (bytes > ctx.limits.maxOutputSize - fallbackOutputBytes) {
          throw new ExecutionLimitError(
            `find: output size limit exceeded (${ctx.limits.maxOutputSize} bytes)`,
            "output_size",
          );
        }
        if (value) stdoutChunks.push(value);
        fallbackOutputBytes += bytes;
      }
    };
    const appendStderr = (value: string): void => {
      if (output) output.append("stderr", value);
      else {
        const bytes = utf8ByteLength(value);
        if (bytes > ctx.limits.maxOutputSize - fallbackOutputBytes) {
          throw new ExecutionLimitError(
            `find: output size limit exceeded (${ctx.limits.maxOutputSize} bytes)`,
            "output_size",
          );
        }
        if (value) stderrChunks.push(value);
        fallbackOutputBytes += bytes;
      }
    };

    // Collect and resolve -newer reference file mtimes
    const newerRefPaths = collectNewerRefs(expr);
    const newerRefTimes = new Map<string, number>();

    for (const refPath of newerRefPaths) {
      const refFullPath = ctx.fs.resolvePath(ctx.cwd, refPath);
      try {
        const refStat = await ctx.fs.stat(refFullPath);
        newerRefTimes.set(refPath, refStat.mtime?.getTime() ?? Date.now());
      } catch (error) {
        // (1ctx find-exec) GNU fails before the walk
        return {
          stdout: "",
          stderr: `find: ${diagnosticPath(refPath)}: ${fsErrorWords(error) ?? "No such file or directory"}\n`,
          exitCode: 1,
        };
      }
    }

    // Check if printf format needs stat metadata
    // Simple directives: %f %h %p %P %d %% don't need stat
    // Stat-dependent: %s %m %M %t %T need stat
    const printfNeedsStat = expressionActions.some((a) => {
      if (a.type !== "printf") return false;
      // Check for stat-dependent directives: %s %m %M %t %T
      // But skip escaped %% and handle width/precision modifiers like %10s or %-5.2s
      const format = a.format.replace(/%%/g, "");
      return /%[-+]?[0-9]*\.?[0-9]*(s|m|M|t|T)/.test(format);
    });

    // Check if expression needs full stat metadata (optimization)
    const needsStatMetadata =
      expressionNeedsStatMetadata(expr) || printfNeedsStat;

    // Check if expression uses -empty (needs to read directories to count entries)
    const needsEmptyCheck = expressionNeedsEmptyCheck(expr);

    // Check if expression has -prune (for early prune optimization)
    const hasPruneExpr = expressionHasPrune(expr);

    // Check if expression is simple (only name/path/type/prune/print)
    // Simple expressions can use the fast-path that avoids EvalContext allocation
    const isSimpleExpr = isSimpleExpression(expr);

    // Check if readdirWithFileTypes is available (for optimization)
    const hasReaddirWithFileTypes =
      typeof ctx.fs.readdirWithFileTypes === "function";

    // Batch -exec nodes collect only paths for which that exact expression node
    // was reached. All other effects retain entry and expression order.
    const batchExecPaths = new Map<FindAction, string[]>();

    // (1ctx find-exec) a command with its arguments, its output in order with
    // find's own, answering its exit code
    const runCommand = async (command: string[]): Promise<number> => {
      if (!ctx.exec) return 1;
      traversalBudget.checkpoint();
      const result = await ctx.exec(shellJoinArgs([command[0]]), {
        // (1ctx exec-env) the command is a process: it sees the exported variables
        env: { ...ctx.exportedEnv },
        replaceEnv: true,
        cwd: ctx.cwd,
        signal: ctx.signal,
        args: command.slice(1),
      });
      if (output) output.appendResult(result);
      else {
        appendStdout(result.stdout);
        appendStderr(result.stderr);
      }
      return result.exitCode;
    };

    // (1ctx find-exec) an effect performed, answering the action's truth:
    // `-exec ;` is true when its command succeeds, the others always. -delete
    // runs in the live walk, which knows what the entry was.
    const perform = async (effect: EvaluatedEffect): Promise<boolean> => {
      const { action, path: file } = effect;
      switch (action.type) {
        case "diagnostic":
          appendStderr(action.message);
          exitCode = 1;
          return false;
        case "print":
          appendStdout(`${file}\n`);
          return true;
        case "print0":
          appendStdout(`${file}\0`);
          return true;
        case "printf":
          appendStdout(formatFindPrintf(action.format, effect.printfData));
          return true;
        case "delete":
          return false;
        case "exec": {
          if (action.batchMode) {
            const paths = batchExecPaths.get(action) ?? [];
            paths.push(file);
            batchExecPaths.set(action, paths);
            return true;
          }
          // every `{}`, inside a larger argument too, with no shell reading
          const command = action.command.map((part) =>
            part.replaceAll("{}", file),
          );
          return (await runCommand(command)) === 0;
        }
      }
    };

    // (1ctx find-exec) -delete on an entry the walk met as a folder or not,
    // read from the folder whose real path was `parentReal`. GNU removes by
    // the type it met, so a folder swapped for a file is `Not a directory`.
    // Removal goes by path, where GNU's goes through the folder it read: an
    // entry whose folder moved is refused rather than removed through the
    // swapped path.
    const deleteEntry = async (
      file: string,
      name: string,
      wasDirectory: boolean,
      parentReal: string | undefined,
    ): Promise<boolean> => {
      // GNU never removes the folder it stands in
      if (name === ".") return true;
      const fullPath = ctx.fs.resolvePath(ctx.cwd, file);
      const fail = (words: string) => {
        appendStderr(`find: cannot delete ${diagnosticPath(file)}: ${words}\n`);
        exitCode = 1;
        return false;
      };
      let now: Awaited<ReturnType<typeof ctx.fs.lstat>>;
      try {
        now = await ctx.fs.lstat(fullPath);
      } catch {
        return fail("No such file or directory");
      }
      if (wasDirectory && !now.isDirectory) return fail("Not a directory");
      if (!wasDirectory && now.isDirectory) return fail("Is a directory");
      if (parentReal !== undefined) {
        const parent = fullPath.slice(0, fullPath.lastIndexOf("/")) || "/";
        const real = await ctx.fs.realpath(parent).catch(() => undefined);
        if (real !== parentReal) return fail("No such file or directory");
      }
      try {
        await ctx.fs.rm(fullPath, { recursive: false });
        return true;
      } catch (e) {
        // (1ctx readonly-errors) the words, never the backend's own path
        return fail(
          isReadOnlyError(e)
            ? "Read-only file system"
            : fsErrorCode(e) === "EBUSY"
              ? "Device or resource busy"
              : (fsErrorWords(e) ??
                  (e instanceof Error ? e.message : String(e))),
        );
      }
    };

    // Process each search path
    for (let searchPath of searchPaths) {
      // (1ctx find-exec) messages name the starting point as given
      const given = searchPath;
      // (1ctx find-links) a trailing slash resolves a symbolic link, as in any path
      const slashed = searchPath.length > 1 && searchPath.endsWith("/");
      // Normalize trailing slashes (except for root "/")
      if (slashed) {
        searchPath = searchPath.slice(0, -1);
      }
      const basePath = ctx.fs.resolvePath(ctx.cwd, searchPath);
      // (1ctx find-links) whether a starting point, or anything under it, is read
      // through its symbolic link: -L everywhere, -H at the start only
      const followsAt = (depth: number) =>
        follow === "L" || (depth === 0 && (follow === "H" || slashed));

      // Check if path exists
      // (1ctx find-links) a starting point that is a link exists when the link does,
      // unless it is followed through a trailing slash
      // (1ctx find-exec) as GNU's: '' names nothing, and a slash wants a folder
      let startProblem: string | undefined;
      if (given === "") startProblem = "No such file or directory";
      else {
        try {
          const start = slashed
            ? await ctx.fs.stat(basePath)
            : await ctx.fs.lstat(basePath);
          if (slashed && !start.isDirectory) startProblem = "Not a directory";
        } catch {
          startProblem = "No such file or directory";
        }
      }
      if (startProblem !== undefined) {
        // (1ctx find-diagnostics) after the starting points before it, not
        // ahead of their -exec output
        const missing: EvaluatedEffect = {
          action: {
            type: "diagnostic",
            message: `find: ${diagnosticPath(given)}: ${startProblem}\n`,
          },
          path: searchPath,
          printfData: {
            path: searchPath,
            name: searchPath,
            size: 0,
            mtime: 0,
            mode: 0,
            isDirectory: false,
            depth: 0,
            startingPoint: searchPath,
          },
        };
        if (live) await perform(missing);
        else effects.push(missing);
        continue;
      }

      // Work item for iterative traversal
      interface WorkItem {
        path: string;
        depth: number;
        // (1ctx find-links) a dirent's type describes the link, not its target
        typeInfo?: {
          isFile: boolean;
          isDirectory: boolean;
          isSymbolicLink?: boolean;
        };
        // (1ctx find-links) under -L, the real paths of the directories above, to
        // find a link back into one of them
        ancestors?: string[];
        // For ordered results: index where this item's results go
        resultIndex: number;
      }

      // Processed node info
      interface ProcessedNode {
        relativePath: string;
        name: string;
        isFile: boolean;
        isDirectory: boolean;
        isEmpty: boolean;
        stat?: Awaited<ReturnType<typeof ctx.fs.stat>>;
        depth: number;
        children: WorkItem[];
        pruned: boolean;
        /** Why the directory could not be read, when it could not. */
        unreadable?: string;
        // (1ctx find-links find-diagnostics) GNU's words for what -L met: a
        // loop, or a link that cannot be read through. The node is left out
        // and only the message, in its place, remains; exit 1
        problem?: string;
      }

      // (1ctx find-links) link failures name the same path as a printed node
      // (1ctx find-exec) the starting point as typed, its slash kept
      const relativeOf = (currentPath: string) =>
        currentPath === basePath
          ? slashed
            ? `${searchPath}/`
            : searchPath
          : searchPath === "."
            ? `./${currentPath.slice(basePath === "/" ? basePath.length : basePath.length + 1)}`
            : searchPath + currentPath.slice(basePath.length);

      // Tracing counters
      const traceCounters = createTraceCounters();
      const traceStartTime = Date.now();

      // Process a single node: get stat, children, check prune
      async function processNode(
        item: WorkItem,
      ): Promise<ProcessedNode | null> {
        const { path: currentPath, depth, typeInfo } = item;
        // (1ctx find-links) -H applies to this depth only
        const followed = followsAt(depth);
        traversalBudget.visit(depth);
        traceCounters.nodeCount++;

        // The shared traversal limit remains in force even without -maxdepth.
        if (depth > (maxDepth ?? ctx.limits.maxTraversalDepth)) {
          return null;
        }

        // Get type info
        let isFile: boolean;
        let isDirectory: boolean;
        let stat: Awaited<ReturnType<typeof ctx.fs.stat>> | undefined;

        // (1ctx find-links) followed links need their target's type
        if (
          typeInfo &&
          !needsStatMetadata &&
          !(followed && typeInfo.isSymbolicLink)
        ) {
          isFile = typeInfo.isFile;
          isDirectory = typeInfo.isDirectory;
        } else {
          try {
            const statStart = Date.now();
            // find defaults to the POSIX -P policy: inspect symlinks, never
            // follow them while deciding whether to descend.
            // (1ctx find-links) -L and -H read through a link; a broken one is itself
            stat = followed
              ? await ctx.fs.stat(currentPath).catch((error: unknown) => {
                  if (isMissing(error)) return ctx.fs.lstat(currentPath);
                  throw error;
                })
              : await ctx.fs.lstat(currentPath);
            traceCounters.statCalls++;
            traceCounters.statTime += Date.now() - statStart;
          } catch (error) {
            // (1ctx find-links find-diagnostics) a link that loops is GNU's
            // quoted error, not a missing file
            if (followed && !isMissing(error)) {
              return problemNode(
                item,
                `find: ${diagnosticPath(relativeOf(currentPath))}: ${statWords(error)}\n`,
              );
            }
            return null;
          }
          if (!stat) return null;
          isFile = stat.isFile;
          isDirectory = stat.isDirectory;
        }

        // Compute name and relative path
        let name: string;
        if (currentPath === basePath) {
          name = searchPath.split("/").pop() || searchPath;
        } else {
          name = currentPath.split("/").pop() || "";
        }

        // (1ctx find-links) share the spelling with link failures
        const relativePath = relativeOf(currentPath);

        // (1ctx find-links find-diagnostics) under -L, a directory reached
        // again through a link is GNU's quoted file system loop, exit 1
        let ancestors: string[] | undefined;
        if (follow === "L" && isDirectory) {
          const parent = item.ancestors ?? [];
          const real = await ctx.fs.realpath(currentPath);
          if (parent.includes(real)) {
            return problemNode(
              item,
              `find: File system loop detected; the following directory is part of the cycle: ${diagnosticPath(relativePath)}\n`,
            );
          }
          ancestors = [...parent, real];
        }

        // Get children for directories
        const children: WorkItem[] = [];
        let entriesWithTypes: DirentEntry[] | null = null;
        let entries: string[] | null = null;

        // Early prune optimization: check if we can skip this directory before readdir
        // This avoids reading directory contents for directories that will be pruned
        let earlyPruned = false;
        // (1ctx find-exec) GNU does not evaluate above -mindepth, so -prune
        // stops nothing there
        const evaluated = minDepth === null || depth >= minDepth;
        if (isDirectory && hasPruneExpr && !depthFirst && evaluated) {
          // (1ctx find-exec) without -empty the whole expression is known
          // before the read, an action or metadata test on the left included
          earlyPruned =
            needsEmptyCheck || expr === null
              ? evaluateForEarlyPrune(expr, {
                  name,
                  relativePath,
                  isFile,
                  isDirectory,
                }).shouldPrune
              : evaluateExpressionWithPrune(expr, {
                  name,
                  relativePath,
                  isFile,
                  isDirectory,
                  isEmpty: false,
                  mtime: stat?.mtime?.getTime() ?? Date.now(),
                  size: stat?.size ?? 0,
                  mode: stat?.mode ?? 0o644,
                  newerRefTimes,
                }).pruned;
          if (earlyPruned) {
            traceCounters.earlyPrunes++;
          }
        }

        // Optimization: skip reading directory contents if we're at maxdepth
        // Exception: if -empty is used, we need to read to check if directory is empty
        const atMaxDepth = depth >= (maxDepth ?? ctx.limits.maxTraversalDepth);
        const shouldDescendIntoSubdirs = !atMaxDepth && !earlyPruned;
        const shouldReadDir =
          (shouldDescendIntoSubdirs || needsEmptyCheck) && !earlyPruned;

        let unreadable: string | undefined;
        if (isDirectory && shouldReadDir) {
          const readdirStart = Date.now();
          try {
            if (hasReaddirWithFileTypes && ctx.fs.readdirWithFileTypes) {
              entriesWithTypes = await ctx.fs.readdirWithFileTypes(currentPath);
            } else {
              entries = await ctx.fs.readdir(currentPath);
            }
          } catch (error) {
            // GNU find names the directory it could not read and carries on,
            // exiting 1 at the end. Throwing here instead turned one unreadable
            // directory into an empty result for the whole search, and on a
            // home directory there is always one. The message is emitted with
            // the node's effects, in traversal order, not here in batch order.
            const reason = describeUnreadableDirectory(error);
            if (reason === null) throw error;
            unreadable = reason;
            traceCounters.readdirCalls++;
            traceCounters.readdirTime += Date.now() - readdirStart;
          }
          if (entriesWithTypes !== null) {
            traversalBudget.checkpoint();
            traversalBudget.discover(entriesWithTypes.length);
            entries = [];
            for (const entry of entriesWithTypes) entries.push(entry.name);
            traceCounters.readdirCalls++;
            traceCounters.readdirTime += Date.now() - readdirStart;
            // Create children work items
            // In terminal directory (e.g., "pulls" for pattern "*/pulls/*.json"),
            // only process files, not subdirectories
            if (shouldDescendIntoSubdirs) {
              for (let idx = 0; idx < entriesWithTypes.length; idx++) {
                const entry = entriesWithTypes[idx];
                children.push({
                  path:
                    currentPath === "/"
                      ? `/${entry.name}`
                      : `${currentPath}/${entry.name}`,
                  depth: depth + 1,
                  typeInfo: {
                    isFile: entry.isFile,
                    isDirectory: entry.isDirectory,
                    // (1ctx find-links) -L must stat links, not trust dirents
                    isSymbolicLink: entry.isSymbolicLink,
                  },
                  ancestors,
                  resultIndex: idx,
                });
              }
            }
          } else if (entries !== null) {
            traversalBudget.checkpoint();
            traversalBudget.discover(entries.length);
            traceCounters.readdirCalls++;
            traceCounters.readdirTime += Date.now() - readdirStart;
            // Create children work items
            if (shouldDescendIntoSubdirs) {
              for (let idx = 0; idx < entries.length; idx++) {
                const entry = entries[idx];
                children.push({
                  path:
                    currentPath === "/"
                      ? `/${entry}`
                      : `${currentPath}/${entry}`,
                  depth: depth + 1,
                  // (1ctx find-links) track ancestors without typed readdir too
                  ancestors,
                  resultIndex: idx,
                });
              }
            }
          }
        }

        const isEmpty = isFile
          ? (stat?.size ?? 0) === 0
          : entries !== null && entries.length === 0;

        // Check for pruning (only in pre-order mode when expression has -prune)
        // If we already early-pruned, use that result
        // Skip this evaluation entirely if there's no -prune in the expression
        let pruned = earlyPruned;
        if (
          !depthFirst &&
          expr !== null &&
          !earlyPruned &&
          hasPruneExpr &&
          evaluated
        ) {
          const evalStart = Date.now();
          const evalCtx: EvalContext = {
            name,
            relativePath,
            isFile,
            isDirectory,
            isEmpty,
            mtime: stat?.mtime?.getTime() ?? Date.now(),
            size: stat?.size ?? 0,
            mode: stat?.mode ?? 0o644,
            newerRefTimes,
          };
          const evalResult = evaluateExpressionWithPrune(expr, evalCtx);
          pruned = evalResult.pruned;
          traceCounters.evalCalls++;
          traceCounters.evalTime += Date.now() - evalStart;
        }
        // (1ctx find-diagnostics) a read made only for the descent -prune
        // stopped, which GNU never attempts; -empty's own read GNU reports
        if (pruned && !needsEmptyCheck) unreadable = undefined;

        return {
          relativePath,
          name,
          isFile,
          isDirectory,
          isEmpty,
          stat,
          depth,
          children: pruned ? [] : children,
          pruned,
          unreadable,
        };
      }

      // (1ctx find-links find-diagnostics) a node left out, holding only the
      // message that takes its place in the output
      function problemNode(item: WorkItem, problem: string): ProcessedNode {
        const relativePath = relativeOf(item.path);
        return {
          relativePath,
          name: item.path.split("/").pop() || relativePath,
          isFile: false,
          isDirectory: false,
          isEmpty: false,
          depth: item.depth,
          children: [],
          pruned: false,
          problem,
        };
      }

      // (1ctx find-exec) The walk for `-exec ;` and `-delete`: one entry at a
      // time, in order, each action run when evaluation reaches it. An entry
      // is stat'ed when the walk arrives, and a folder again right before it
      // is read, since a command may have removed it or swapped it for a
      // link; GNU then says why and does not descend. `parentReal` is the
      // real path of the folder an entry was read from, so -delete never
      // removes through a folder swapped after the read.
      let liveResults = 0;
      const liveDiagnostic = (path: string, words: string) =>
        perform({
          action: {
            type: "diagnostic",
            message: `find: ${diagnosticPath(path)}: ${words}\n`,
          },
          path,
          printfData: emptyPrintfData,
        });
      const emptyPrintfData: FindResult = {
        path: searchPath,
        name: searchPath,
        size: 0,
        mtime: 0,
        mode: 0,
        isDirectory: false,
        depth: 0,
        startingPoint: searchPath,
      };
      // the words for a failed read, or a throw for a failure find must not
      // recover from
      const readWords = (error: unknown): string => {
        const words = describeUnreadableDirectory(error);
        if (words === null) throw error;
        return words;
      };

      async function walkLive(
        item: WorkItem,
        parentReal: string | undefined,
      ): Promise<void> {
        const { path: currentPath, depth } = item;
        const followed = followsAt(depth);
        traversalBudget.visit(depth);
        const limit = maxDepth ?? ctx.limits.maxTraversalDepth;
        if (depth > limit) return;
        const readEntry = () =>
          followed
            ? ctx.fs.stat(currentPath).catch((error: unknown) => {
                if (isMissing(error)) return ctx.fs.lstat(currentPath);
                throw error;
              })
            : ctx.fs.lstat(currentPath);
        let stat: Awaited<ReturnType<typeof ctx.fs.stat>>;
        try {
          stat = await readEntry();
        } catch (error) {
          if (followed && !isMissing(error)) {
            await liveDiagnostic(relativeOf(currentPath), statWords(error));
          }
          return;
        }
        const isFile = stat.isFile;
        const isDirectory = stat.isDirectory;
        const name =
          currentPath === basePath
            ? searchPath.split("/").pop() || searchPath
            : currentPath.split("/").pop() || "";
        const relativePath = relativeOf(currentPath);

        let ancestors: string[] | undefined;
        if (follow === "L" && isDirectory) {
          const parent = item.ancestors ?? [];
          const real = await ctx.fs.realpath(currentPath);
          if (parent.includes(real)) {
            await perform({
              action: {
                type: "diagnostic",
                message: `find: File system loop detected; the following directory is part of the cycle: ${diagnosticPath(relativePath)}\n`,
              },
              path: relativePath,
              printfData: emptyPrintfData,
            });
            return;
          }
          ancestors = [...parent, real];
        }

        const descend = isDirectory && depth < limit;
        const evaluated = minDepth === null || depth >= minDepth;

        // the folder read now, after whatever ran before it
        const readChildren = async (): Promise<{
          children: WorkItem[];
          real: string | undefined;
        } | null> => {
          let now: Awaited<ReturnType<typeof ctx.fs.stat>>;
          try {
            now = await readEntry();
          } catch (error) {
            await liveDiagnostic(relativePath, readWords(error));
            return null;
          }
          if (!now.isDirectory) {
            await liveDiagnostic(relativePath, "Not a directory");
            return null;
          }
          let names: string[];
          try {
            names =
              hasReaddirWithFileTypes && ctx.fs.readdirWithFileTypes
                ? (await ctx.fs.readdirWithFileTypes(currentPath)).map(
                    (entry) => entry.name,
                  )
                : await ctx.fs.readdir(currentPath);
          } catch (error) {
            await liveDiagnostic(relativePath, readWords(error));
            return null;
          }
          traversalBudget.checkpoint();
          traversalBudget.discover(names.length);
          const real = hasDelete
            ? await ctx.fs.realpath(currentPath)
            : undefined;
          return {
            real,
            children: names.map((entry, idx) => ({
              path:
                currentPath === "/" ? `/${entry}` : `${currentPath}/${entry}`,
              depth: depth + 1,
              ancestors,
              resultIndex: idx,
            })),
          };
        };

        const walkChildren = async () => {
          const read = await readChildren();
          if (read === null) return;
          for (const child of read.children) await walkLive(child, read.real);
        };

        const printfData: FindResult = {
          path: relativePath,
          name,
          size: stat.size ?? 0,
          mtime: stat.mtime?.getTime() ?? Date.now(),
          mode: stat.mode ?? 0o644,
          isDirectory,
          depth,
          startingPoint: searchPath,
        };

        const evaluate = async (): Promise<boolean> => {
          // a live walk always has an expression: it holds the actions
          if (!evaluated || expr === null) return false;
          const result = await evaluateLive(
            expr,
            {
              name,
              relativePath,
              isFile,
              isDirectory,
              isEmpty: false,
              mtime: printfData.mtime,
              size: printfData.size,
              mode: printfData.mode,
              newerRefTimes,
            },
            {
              action: async (action) => {
                traversalBudget.checkpoint();
                liveResults++;
                if (action.type !== "delete") {
                  return perform({ action, path: relativePath, printfData });
                }
                return deleteEntry(relativePath, name, isDirectory, parentReal);
              },
              empty: async () => {
                if (isFile) return (stat.size ?? 0) === 0;
                if (!isDirectory) return false;
                try {
                  return (await ctx.fs.readdir(currentPath)).length === 0;
                } catch (error) {
                  await liveDiagnostic(relativePath, readWords(error));
                  return false;
                }
              },
            },
          );
          return result.pruned;
        };

        if (depthFirst) {
          if (descend) await walkChildren();
          await evaluate();
        } else {
          const pruned = await evaluate();
          if (descend && !pruned) await walkChildren();
        }
      }

      // Evaluate once in traversal order and retain only actions whose branch was
      // actually reached. Side effects themselves run after traversal is complete.
      function evaluateNode(node: ProcessedNode): EvaluatedEffect[] {
        const printfData: FindResult = {
          path: node.relativePath,
          name: node.name,
          size: node.stat?.size ?? 0,
          mtime: node.stat?.mtime?.getTime() ?? Date.now(),
          mode: node.stat?.mode ?? 0o644,
          isDirectory: node.isDirectory,
          depth: node.depth,
          startingPoint: searchPath,
        };
        // (1ctx find-links find-diagnostics) a left-out node is its message,
        // whatever -mindepth says, as GNU's
        if (node.problem !== undefined) {
          return [
            {
              action: { type: "diagnostic", message: node.problem },
              path: node.relativePath,
              printfData,
            },
          ];
        }
        // Reported whatever -mindepth says, as GNU does: the expression never
        // ran on it, but the traversal did fail there. Before the node's own
        // output under -depth, where GNU meets the failure on the way down and
        // prints the directory on the way back up; after it otherwise.
        const diagnostics: EvaluatedEffect[] =
          node.unreadable === undefined
            ? []
            : [
                {
                  action: {
                    type: "diagnostic",
                    // (1ctx find-diagnostics) quote directory errors like links
                    message: `find: ${diagnosticPath(node.relativePath)}: ${node.unreadable}\n`,
                  },
                  path: node.relativePath,
                  printfData,
                },
              ];
        const withDiagnostics = (evaluated: EvaluatedEffect[]) =>
          depthFirst
            ? [...diagnostics, ...evaluated]
            : [...evaluated, ...diagnostics];

        const atOrBeyondMinDepth = minDepth === null || node.depth >= minDepth;
        if (!atOrBeyondMinDepth) return diagnostics;

        let matches = true;
        let reachedActions: FindAction[] = [];

        if (expr !== null) {
          const evalStart = Date.now();
          let evalResult: EvalResult;

          // Use fast-path for simple expressions to avoid EvalContext allocation
          if (isSimpleExpr) {
            evalResult = evaluateSimpleExpression(
              expr,
              node.name,
              node.relativePath,
              node.isFile,
              node.isDirectory,
            );
          } else {
            const evalCtx: EvalContext = {
              name: node.name,
              relativePath: node.relativePath,
              isFile: node.isFile,
              isDirectory: node.isDirectory,
              isEmpty: node.isEmpty,
              mtime: node.stat?.mtime?.getTime() ?? Date.now(),
              size: node.stat?.size ?? 0,
              mode: node.stat?.mode ?? 0o644,
              newerRefTimes,
            };
            evalResult = evaluateExpressionWithPrune(expr, evalCtx);
          }

          matches = evalResult.matches;
          reachedActions = evalResult.actions ?? [];
          traceCounters.evalCalls++;
          traceCounters.evalTime += Date.now() - evalStart;
        }

        if (!hasAnyAction && matches) {
          reachedActions = [{ type: "print" }];
        }
        if (reachedActions.length === 0) return diagnostics;

        traversalBudget.checkpoint(reachedActions.length);
        const evaluated: EvaluatedEffect[] = [];
        for (const action of reachedActions) {
          evaluated.push({
            action,
            path: node.relativePath,
            printfData,
          });
        }
        return withDiagnostics(evaluated);
      }

      // Result collection for ordered results
      interface NodeResult {
        effects: EvaluatedEffect[];
      }

      // Iterative depth-first traversal with parallel processing
      // Uses work array with slot-based result collection for ordering
      async function findIterative(): Promise<NodeResult> {
        const finalResult: NodeResult = { effects: [] };

        // For depth-first (post-order), we use a different strategy:
        // 1. Discover all nodes level by level (BFS with parallel batches)
        // 2. Track parent-child relationships
        // 3. Build results bottom-up maintaining tree order

        if (depthFirst) {
          // Phase 1: Discover all nodes (BFS to get structure)
          interface DiscoveredNode {
            node: ProcessedNode;
            parentIndex: number; // -1 for root
            childIndices: number[]; // filled in after all children discovered
          }

          const discovered: DiscoveredNode[] = [];

          // Queue item includes parent index for tracking
          interface QueueItem {
            item: WorkItem;
            parentIndex: number;
            childOrderInParent: number; // which child of parent this is
          }

          const workQueue: QueueItem[] = [
            {
              item: { path: basePath, depth: 0, resultIndex: 0 },
              parentIndex: -1,
              childOrderInParent: 0,
            },
          ];

          // Track which discovered index each queue item will become
          const parentChildMap = new Map<number, number[]>(); // parentIdx -> [childIdx in order]

          // BFS to discover all nodes with parallel processing
          let workCursor = 0;
          while (workCursor < workQueue.length) {
            const batchStart = Date.now();
            const batchEnd = Math.min(
              workQueue.length,
              workCursor + FIND_BATCH_SIZE,
            );
            const batch = workQueue.slice(workCursor, batchEnd);
            workCursor = batchEnd;
            // (1ctx find-batch)
            const nodes = await settleBatch(
              batch.map((q) => processNode(q.item)),
            );
            traceCounters.batchCount++;
            traceCounters.batchTime += Date.now() - batchStart;

            for (let i = 0; i < batch.length; i++) {
              const node = nodes[i];
              const queueItem = batch[i];
              if (!node) continue;

              const thisIndex = discovered.length;

              // Register this node with its parent
              if (queueItem.parentIndex >= 0) {
                const siblings =
                  parentChildMap.get(queueItem.parentIndex) || [];
                siblings.push(thisIndex);
                parentChildMap.set(queueItem.parentIndex, siblings);
              }

              discovered.push({
                node,
                parentIndex: queueItem.parentIndex,
                childIndices: [], // will be filled from parentChildMap
              });

              // Add children to work queue
              for (let j = 0; j < node.children.length; j++) {
                workQueue.push({
                  item: node.children[j],
                  parentIndex: thisIndex,
                  childOrderInParent: j,
                });
              }
            }
          }

          // Fill in childIndices from parentChildMap
          for (const [parentIdx, childIndices] of parentChildMap) {
            if (parentIdx >= 0 && parentIdx < discovered.length) {
              discovered[parentIdx].childIndices = childIndices;
            }
          }

          // Phase 2: Build post-order iteratively. Recursive reconstruction can
          // overflow the host stack at traversal depths that are deliberately
          // valid under a liberal normal profile.
          if (discovered.length > 0) {
            const stack: Array<{ index: number; visited: boolean }> = [
              { index: 0, visited: false },
            ];
            while (stack.length > 0) {
              traversalBudget.checkpoint();
              const current = stack.pop();
              if (!current) break;
              const entry = discovered[current.index];
              if (!entry) continue;
              if (current.visited) {
                for (const effect of evaluateNode(entry.node)) {
                  finalResult.effects.push(effect);
                }
                continue;
              }
              stack.push({ index: current.index, visited: true });
              for (let i = entry.childIndices.length - 1; i >= 0; i--) {
                stack.push({ index: entry.childIndices[i], visited: false });
              }
            }
          }
        } else {
          // Pre-order traversal using BFS with batched processing
          // This maximizes parallelism while maintaining pre-order output

          interface NodeWithOrder {
            node: ProcessedNode;
            orderIndex: number;
          }

          const nodeResults: Map<number, EvaluatedEffect[]> = new Map();
          let orderCounter = 0;

          // BFS queue with order tracking
          const workQueue: Array<{ item: WorkItem; orderIndex: number }> = [
            {
              item: { path: basePath, depth: 0, resultIndex: 0 },
              orderIndex: orderCounter++,
            },
          ];

          // Track child order indices for each parent
          const childOrders: Map<number, number[]> = new Map();

          let workCursor = 0;
          while (workCursor < workQueue.length) {
            // Process all items in the queue in parallel batches
            const batchStart = Date.now();
            const batchEnd = Math.min(
              workQueue.length,
              workCursor + FIND_BATCH_SIZE,
            );
            const batch = workQueue.slice(workCursor, batchEnd);
            workCursor = batchEnd;
            // (1ctx find-batch)
            const processed: Array<NodeWithOrder | null> = await settleBatch(
              batch.map(async ({ item, orderIndex }) => {
                const node = await processNode(item);
                return node ? { node, orderIndex } : null;
              }),
            );
            traceCounters.batchCount++;
            traceCounters.batchTime += Date.now() - batchStart;

            for (const result of processed) {
              if (!result) continue;
              const { node, orderIndex } = result;

              const nodeEffects = evaluateNode(node);
              if (nodeEffects.length > 0)
                nodeResults.set(orderIndex, nodeEffects);

              // Add children to work queue with consecutive order indices
              if (node.children.length > 0) {
                const childIndices: number[] = [];
                for (const child of node.children) {
                  const childOrder = orderCounter++;
                  childIndices.push(childOrder);
                  workQueue.push({ item: child, orderIndex: childOrder });
                }
                childOrders.set(orderIndex, childIndices);
              }
            }
          }

          // Build result in pre-order with an explicit stack.
          const collectionStack = [0];
          while (collectionStack.length > 0) {
            traversalBudget.checkpoint();
            const orderIndex = collectionStack.pop();
            if (orderIndex === undefined) break;
            const nodeResult = nodeResults.get(orderIndex);
            if (nodeResult) {
              for (const effect of nodeResult) {
                finalResult.effects.push(effect);
              }
            }
            const children = childOrders.get(orderIndex);
            if (children) {
              for (let i = children.length - 1; i >= 0; i--) {
                collectionStack.push(children[i]);
              }
            }
          }
        }

        return finalResult;
      }

      // (1ctx find-exec) the live walk, or the batched one
      let resultsFound = 0;
      if (live) {
        await walkLive({ path: basePath, depth: 0, resultIndex: 0 }, undefined);
        resultsFound = liveResults;
      } else {
        const searchResult = await findIterative();
        for (const effect of searchResult.effects) effects.push(effect);
        resultsFound = searchResult.effects.filter(
          (effect) => effect.action.type !== "diagnostic",
        ).length;
      }

      // Emit trace summary for this search path
      if (ctx.trace) {
        const totalMs = Date.now() - traceStartTime;
        emitTraceSummary(ctx.trace, traceCounters, totalMs);
        ctx.trace({
          category: "find",
          name: "searchPath",
          durationMs: totalMs,
          details: {
            path: searchPath,
            resultsFound,
          },
        });
      }
    }

    // (1ctx find-exec) the live walk performed its effects as it went
    if (!live) {
      for (const effect of effects) await perform(effect);
    }

    for (const [action, paths] of batchExecPaths) {
      if (action.type !== "exec" || paths.length === 0) continue;
      const cmdWithFiles: string[] = [];
      for (const part of action.command) {
        if (part === "{}") cmdWithFiles.push(...paths);
        else cmdWithFiles.push(part);
      }
      // (1ctx find-exec) a failed batch is find's exit 1, as GNU's
      if ((await runCommand(cmdWithFiles)) !== 0) exitCode = 1;
    }

    return (
      output?.build(exitCode) ?? {
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode,
      }
    );
  },
};

function collectActions(expr: Expression | null): FindAction[] {
  if (!expr) return [];
  if (expr.type === "action") return [expr.action];
  if (expr.type === "not") return collectActions(expr.expr);
  if (expr.type === "and" || expr.type === "or") {
    return [...collectActions(expr.left), ...collectActions(expr.right)];
  }
  return [];
}

/**
 * Format a find -printf format string
 * Supported directives (all support optional width/precision like %-20.10f):
 * %f - file basename (filename without directory)
 * %h - directory name (dirname)
 * %p - full path
 * %P - path without starting point
 * %s - file size in bytes
 * %d - depth in directory tree
 * %m - permissions in octal (without leading 0)
 * %M - symbolic permissions like -rwxr-xr-x
 * %t - modification time in ctime format
 * %T@ - modification time as seconds since epoch
 * %Tk - modification time with strftime format k
 * %% - literal %
 * Also processes escape sequences: \n, \t, etc.
 */
function formatFindPrintf(
  format: string,
  result: {
    path: string;
    name: string;
    size: number;
    mtime: number;
    mode: number;
    isDirectory: boolean;
    depth: number;
    startingPoint: string;
  },
): string {
  // First process escape sequences
  const processed = processEscapes(format);

  let output = "";
  let i = 0;

  while (i < processed.length) {
    if (processed[i] === "%" && i + 1 < processed.length) {
      i++; // skip %

      // Check for %% first
      if (processed[i] === "%") {
        output += "%";
        i++;
        continue;
      }

      // Parse optional width/precision (e.g., %-20.10)
      const [width, precision, consumed] = parseWidthPrecision(processed, i);
      i += consumed;

      if (i >= processed.length) {
        output += "%";
        break;
      }

      const directive = processed[i];
      let value: string;

      switch (directive) {
        case "f":
          // Filename (basename)
          value = result.name;
          i++;
          break;
        case "h": {
          // Directory (dirname)
          const lastSlash = result.path.lastIndexOf("/");
          value = lastSlash > 0 ? result.path.slice(0, lastSlash) : ".";
          i++;
          break;
        }
        case "p":
          // Full path
          value = result.path;
          i++;
          break;
        case "P": {
          // Path without starting point
          const sp = result.startingPoint;
          if (result.path === sp) {
            value = "";
          } else if (result.path.startsWith(`${sp}/`)) {
            value = result.path.slice(sp.length + 1);
          } else if (sp === "." && result.path.startsWith("./")) {
            value = result.path.slice(2);
          } else {
            value = result.path;
          }
          i++;
          break;
        }
        case "s":
          // File size in bytes
          value = String(result.size);
          i++;
          break;
        case "d":
          // Depth in directory tree
          value = String(result.depth);
          i++;
          break;
        case "m":
          // Permissions in octal (without leading 0)
          value = (result.mode & 0o777).toString(8);
          i++;
          break;
        case "M":
          // Symbolic permissions
          value = formatMode(result.mode, result.isDirectory);
          i++;
          break;
        case "t": {
          // Modification time in ctime format
          const date = new Date(result.mtime);
          value = formatCtimeDate(date);
          i++;
          break;
        }
        case "T": {
          // Time format: %T@ for epoch, %TY for year, etc.
          if (i + 1 < processed.length) {
            const timeFormat = processed[i + 1];
            const date = new Date(result.mtime);
            value = formatTimeDirective(date, timeFormat);
            i += 2;
          } else {
            value = "%T";
            i++;
          }
          break;
        }
        default:
          // Unknown directive, keep as-is
          output += `%${width !== 0 || precision !== -1 ? `${width}.${precision}` : ""}${directive}`;
          i++;
          continue;
      }

      // Apply width/precision formatting using shared utility
      output += applyWidth(value, width, precision);
    } else {
      output += processed[i];
      i++;
    }
  }

  return output;
}

// formatMode imported from ../format-mode.js

/**
 * Format date in ctime format: "Wed Dec 25 12:34:56 2024"
 */
function formatCtimeDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const day = days[date.getDay()];
  const month = months[date.getMonth()];
  const dayNum = String(date.getDate()).padStart(2, " ");
  const hours = String(date.getHours()).padStart(2, "0");
  const mins = String(date.getMinutes()).padStart(2, "0");
  const secs = String(date.getSeconds()).padStart(2, "0");
  const year = date.getFullYear();

  return `${day} ${month} ${dayNum} ${hours}:${mins}:${secs} ${year}`;
}

/**
 * (1ctx find-diagnostics) Recovery is by errno, not by cause: ReadWriteFs
 * also uses EACCES for a sandbox refusal, which must not expose its message.
 * Cancellations, limits and errors outside this table still end the search.
 */
const UNREADABLE_DIRECTORY_REASONS = new Map<string, string>([
  ["EACCES", "Permission denied"],
  ["EIO", "Input/output error"],
  ["ELOOP", "Too many levels of symbolic links"],
  ["ENAMETOOLONG", "File name too long"],
  ["ENOENT", "No such file or directory"],
  ["ENOTDIR", "Not a directory"],
  ["EPERM", "Permission denied"],
]);

/**
 * The phrase for a directory that could not be read, from the errno alone,
 * or null when the failure is not one of those, in which case it propagates.
 * The errno is read off `code` when the error carries one and off the
 * `ECODE: ...` message prefix the virtual filesystems use otherwise.
 */
function describeUnreadableDirectory(error: unknown): string | null {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? /^(E[A-Z]+)\b/.exec(error.message)?.[1]
        : undefined;
  if (code === undefined) return null;
  return UNREADABLE_DIRECTORY_REASONS.get(code) ?? null;
}

/**
 * Format time with %T directive format character
 */
function formatTimeDirective(date: Date, format: string): string {
  switch (format) {
    case "@":
      // Seconds since epoch (with fractional part)
      return String(date.getTime() / 1000);
    case "Y":
      // Year with century
      return String(date.getFullYear());
    case "m":
      // Month (01-12)
      return String(date.getMonth() + 1).padStart(2, "0");
    case "d":
      // Day of month (01-31)
      return String(date.getDate()).padStart(2, "0");
    case "H":
      // Hour (00-23)
      return String(date.getHours()).padStart(2, "0");
    case "M":
      // Minute (00-59)
      return String(date.getMinutes()).padStart(2, "0");
    case "S":
      // Second (00-59)
      return String(date.getSeconds()).padStart(2, "0");
    case "T":
      // Time as HH:MM:SS
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
    case "F":
      // Date as YYYY-MM-DD
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    default:
      return `%T${format}`;
  }
}

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "find",
  flags: [
    { flag: "-name", type: "value", valueHint: "pattern" },
    { flag: "-iname", type: "value", valueHint: "pattern" },
    { flag: "-type", type: "value", valueHint: "string" },
    { flag: "-maxdepth", type: "value", valueHint: "number" },
    { flag: "-mindepth", type: "value", valueHint: "number" },
    { flag: "-empty", type: "boolean" },
    { flag: "-print", type: "boolean" },
    { flag: "-print0", type: "boolean" },
  ],
  needsFiles: true,
};
