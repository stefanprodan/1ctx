import { dirname } from "../../fs/path-utils.js";
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import { FileTraversalBudget, traverseFileTree } from "../../fs/traversal.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import { getErrorMessage } from "../../interpreter/helpers/errors.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { parseArgs } from "../../utils/args.js";

const argDefs = {
  recursive: { short: "r", long: "recursive", type: "boolean" as const },
  recursiveUpper: { short: "R", type: "boolean" as const },
  force: { short: "f", long: "force", type: "boolean" as const },
  verbose: { short: "v", long: "verbose", type: "boolean" as const },
};

// (1ctx rm-walk) GNU's words for the errors a backend names by code
const GNU_WORDS: Record<string, string> = {
  ENOENT: "No such file or directory",
  ENOTEMPTY: "Directory not empty",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EROFS: "Read-only file system",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  EBUSY: "Device or resource busy",
  ELOOP: "Too many levels of symbolic links",
};

function errorCode(message: string): string | undefined {
  const code = /\b(E[A-Z]+)\b/.exec(message)?.[1];
  if (code !== undefined && code in GNU_WORDS) return code;
  if (/no such file/i.test(message)) return "ENOENT";
  if (/not empty/i.test(message)) return "ENOTEMPTY";
  return undefined;
}

function gnuWords(message: string): string {
  const code = errorCode(message);
  return code === undefined ? sanitizeErrorMessage(message) : GNU_WORDS[code];
}

// (1ctx rm-walk) a limit or a cancel ends the command, whatever -f says
function isStop(error: unknown): boolean {
  return (
    error instanceof ExecutionLimitError ||
    error instanceof ExecutionAbortedError
  );
}

type Options = { force: boolean; verbose: boolean };
type Report = { stdout: string; stderr: string; failed: boolean };

// (1ctx rm-walk) an iterative post-order walk that never follows a link, charged
// to the command's traversal budget, removing one entry at a time; a
// failed entry is reported by its path and keeps its folders, as GNU's
// fts walk does. The root stays when it was reached through a link.
async function removeTree(
  ctx: RuntimeCommandContext,
  root: string,
  display: string,
  removeRoot: boolean,
  budget: FileTraversalBudget,
  options: Options,
  report: Report,
): Promise<void> {
  const blocked = new Set<string>();
  const base = display.length > 1 ? display.replace(/\/+$/, "") : display;
  const shown = (path: string) =>
    path === root ? display : `${base}${path.slice(root === "/" ? 0 : root.length)}`;
  await traverseFileTree(
    {
      fs: ctx.fs,
      root,
      symlinks: "never",
      includeLeave: true,
      budget,
      limits: ctx.limits,
      signal: ctx.signal,
      executionScope: ctx.executionScope,
      site: "rm",
    },
    async (entry) => {
      const folder = entry.stat.isDirectory && !entry.isSymlink;
      if (folder && entry.phase === "enter") return;
      if (entry.depth === 0 && !removeRoot) return;
      if (blocked.has(entry.path)) return;
      try {
        budget.checkpoint();
        await ctx.fs.rm(entry.path);
        if (options.verbose) {
          report.stdout += folder
            ? `removed directory '${shown(entry.path)}'\n`
            : `removed '${shown(entry.path)}'\n`;
        }
      } catch (error) {
        if (isStop(error)) throw error;
        const message = getErrorMessage(error);
        if (options.force && errorCode(message) === "ENOENT") return;
        report.stderr += `rm: cannot remove '${shown(entry.path)}': ${gnuWords(message)}\n`;
        report.failed = true;
        for (let path = entry.path; path !== root && path !== "/"; ) {
          path = dirname(path);
          blocked.add(path);
        }
      }
    },
  );
}

export const rmCommand: RuntimeCommand = {
  name: "rm",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    const parsed = parseArgs("rm", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const recursive =
      parsed.result.flags.recursive || parsed.result.flags.recursiveUpper;
    const force = parsed.result.flags.force;
    const verbose = parsed.result.flags.verbose;
    const paths = parsed.result.positional;

    if (paths.length === 0) {
      if (force) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return {
        stdout: "",
        stderr: "rm: missing operand\n",
        exitCode: 1,
      };
    }

    const report: Report = { stdout: "", stderr: "", failed: false };
    const budget = new FileTraversalBudget({
      limits: ctx.limits,
      signal: ctx.signal,
      executionScope: ctx.executionScope,
      site: "rm",
    });

    for (const path of paths) {
      const fail = (words: string) => {
        report.stderr += `rm: cannot remove '${path}': ${words}\n`;
        report.failed = true;
      };
      try {
        budget.checkpoint();
        const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
        // (1ctx rm-links) rm removes a link, never what it points to, as GNU rm's
        // lstat does; a trailing slash resolves the link, as in any path
        const slashed = path.length > 1 && path.endsWith("/");
        const stat = slashed
          ? await ctx.fs.stat(fullPath)
          : await ctx.fs.lstat(fullPath);
        if (slashed && !stat.isDirectory) {
          // GNU's ENOTDIR, which -f takes for a missing file
          if (!force) fail(GNU_WORDS.ENOTDIR);
          continue;
        }
        if (stat.isDirectory && !recursive) {
          fail(GNU_WORDS.EISDIR);
          continue;
        }
        if (!stat.isDirectory) {
          await ctx.fs.rm(fullPath);
          if (verbose) report.stdout += `removed '${path}'\n`;
          continue;
        }
        // (1ctx rm-links) GNU's `rm -r link/` empties the folder the link names,
        // then fails to remove the link as a folder: ENOTDIR, which -f
        // takes for a missing file
        const viaLink =
          slashed && (await ctx.fs.lstat(fullPath)).isSymbolicLink;
        const root = viaLink ? await ctx.fs.realpath(fullPath) : fullPath;
        await removeTree(
          ctx,
          root,
          path,
          !viaLink,
          budget,
          { force, verbose },
          report,
        );
        if (viaLink && !force) fail(GNU_WORDS.ENOTDIR);
      } catch (error) {
        if (isStop(error)) throw error;
        const message = getErrorMessage(error);
        // (1ctx rm-walk) -f ignores a missing file only, as GNU's does
        if (force && errorCode(message) === "ENOENT") continue;
        fail(gnuWords(message));
      }
    }

    return {
      stdout: report.stdout,
      stderr: report.stderr,
      exitCode: report.failed ? 1 : 0,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "rm",
  flags: [
    { flag: "-r", type: "boolean" },
    { flag: "-R", type: "boolean" },
    { flag: "-f", type: "boolean" },
    { flag: "-v", type: "boolean" },
  ],
  needsArgs: true,
};
