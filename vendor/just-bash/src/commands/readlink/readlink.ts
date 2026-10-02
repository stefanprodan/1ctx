import { FileTraversalBudget } from "../../fs/traversal.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";

const readlinkHelp = {
  name: "readlink",
  summary: "print resolved symbolic links or canonical file names",
  usage: "readlink [OPTIONS] FILE...",
  options: [
    "-f      canonicalize by following every symlink in every component of the given name recursively",
    "    --help display this help and exit",
  ],
};

export const readlinkCommand: RuntimeCommand = {
  name: "readlink",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(readlinkHelp);
    }

    let canonicalize = false;
    let argIdx = 0;

    // Parse options
    while (argIdx < args.length && args[argIdx].startsWith("-")) {
      const arg = args[argIdx];
      if (arg === "-f" || arg === "--canonicalize") {
        canonicalize = true;
        argIdx++;
      } else if (arg === "--") {
        argIdx++;
        break;
      } else {
        return unknownOption("readlink", arg);
      }
    }

    const files = args.slice(argIdx);

    if (files.length === 0) {
      return { stdout: "", stderr: "readlink: missing operand\n", exitCode: 1 };
    }

    let stdout = "";
    let anyError = false;
    const budget = new FileTraversalBudget({
      limits: ctx.limits,
      signal: ctx.signal,
      executionScope: ctx.executionScope,
      site: "readlink",
      label: "symlink traversal",
    });

    for (const file of files) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);

      try {
        if (canonicalize) {
          // (1ctx fs-links) GNU's canonicalize, one component at a time
          const resolved = await canonicalPath(ctx, file, budget);
          if (resolved === null) anyError = true;
          else stdout += `${resolved}\n`;
        } else {
          // Without -f, just read the symlink target
          const target = await ctx.fs.readlink(filePath);
          stdout += `${target}\n`;
        }
      } catch (error) {
        if (
          error instanceof ExecutionLimitError ||
          error instanceof ExecutionAbortedError
        ) {
          throw error;
        }
        // (1ctx fs-links) a name that cannot be read or resolved fails
        // quietly, as GNU's without -v
        anyError = true;
      }
    }

    return { stdout, stderr: "", exitCode: anyError ? 1 : 0 };
  },
};

/**
 * (1ctx fs-links) readlink -f as GNU's: the components resolved in turn, a
 * link's target put in front of the ones still to go, so `..` after a link
 * climbs from where it led. Every component but the last must exist; a
 * loop of links, a missing folder or a file in the middle answers null.
 */
async function canonicalPath(
  ctx: RuntimeCommandContext,
  file: string,
  budget: FileTraversalBudget,
): Promise<string | null> {
  if (file === "") return null;
  const absolute = file.startsWith("/") ? file : `${ctx.cwd}/${file}`;
  const rest = absolute.split("/").reverse();
  let resolved = "";
  let links = 0;
  while (rest.length > 0) {
    const part = rest.pop() as string;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved = resolved.slice(0, resolved.lastIndexOf("/"));
      continue;
    }
    budget.visit(links);
    const candidate = `${resolved}/${part}`;
    const last = rest.every((next) => next === "" || next === ".");
    let info: Awaited<ReturnType<typeof ctx.fs.lstat>>;
    try {
      info = await ctx.fs.lstat(candidate);
    } catch {
      if (!last) return null;
      resolved = candidate;
      continue;
    }
    if (info.isSymbolicLink) {
      if (++links > 40) return null;
      const target = await ctx.fs.readlink(candidate);
      if (target.startsWith("/")) resolved = "";
      const parts = target.split("/");
      for (let index = parts.length - 1; index >= 0; index--) {
        rest.push(parts[index]);
      }
      continue;
    }
    if (!last && !info.isDirectory) return null;
    resolved = candidate;
  }
  return resolved === "" ? "/" : resolved;
}

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "readlink",
  flags: [
    { flag: "-f", type: "boolean" },
    { flag: "-e", type: "boolean" },
  ],
  needsArgs: true,
};
