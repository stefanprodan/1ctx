import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
// (1ctx walk-links)
import { FileTraversalBudget } from "../../fs/traversal.js";
import { parseArgs } from "../../utils/args.js";
import { DEFAULT_BATCH_SIZE } from "../../utils/constants.js";
// (1ctx walk-links)
import type { DirentEntry } from "../../fs/interface.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import { settleAll } from "../../utils/settle.js";
import { hasHelpFlag, showHelp } from "../help.js";

const treeHelp = {
  name: "tree",
  summary: "list contents of directories in a tree-like format",
  usage: "tree [OPTION]... [DIRECTORY]...",
  options: [
    "-a          include hidden files",
    "-d          list directories only",
    "-L LEVEL    limit depth of directory tree",
    "-f          print full path prefix for each file",
    "-l          follow symbolic links to directories", // (1ctx walk-links)
    "    --help  display this help and exit",
  ],
};

const argDefs = {
  showHidden: { short: "a", type: "boolean" as const },
  directoriesOnly: { short: "d", type: "boolean" as const },
  fullPath: { short: "f", type: "boolean" as const },
  maxDepth: { short: "L", type: "number" as const },
  followLinks: { short: "l", type: "boolean" as const }, // (1ctx walk-links)
};

interface TreeOptions {
  showHidden: boolean;
  directoriesOnly: boolean;
  maxDepth: number | null;
  fullPath: boolean;
  // (1ctx walk-links) the walk's links, its budget and the folders above it
  followLinks: boolean;
  budget: FileTraversalBudget;
}

export const treeCommand: RuntimeCommand = {
  name: "tree",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(treeHelp);
    }

    const parsed = parseArgs("tree", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const options: TreeOptions = {
      showHidden: parsed.result.flags.showHidden,
      directoriesOnly: parsed.result.flags.directoriesOnly,
      maxDepth: parsed.result.flags.maxDepth ?? null,
      fullPath: parsed.result.flags.fullPath,
      // (1ctx walk-links)
      followLinks: parsed.result.flags.followLinks,
      budget: new FileTraversalBudget({
        limits: ctx.limits,
        signal: ctx.signal,
        executionScope: ctx.executionScope,
        site: "tree",
      }),
    };

    const directories = parsed.result.positional;

    // Default to current directory
    if (directories.length === 0) {
      directories.push(".");
    }

    let stdout = "";
    let stderr = "";
    let dirCount = 0;
    let fileCount = 0;

    for (const dir of directories) {
      const result = await buildTree(ctx, dir, options, "", 0);
      stdout += result.output;
      stderr += result.stderr;
      dirCount += result.dirCount;
      fileCount += result.fileCount;
    }

    // Add summary
    stdout += `\n${dirCount} director${dirCount === 1 ? "y" : "ies"}`;
    if (!options.directoriesOnly) {
      stdout += `, ${fileCount} file${fileCount === 1 ? "" : "s"}`;
    }
    stdout += "\n";

    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  },
};

interface TreeResult {
  output: string;
  stderr: string;
  dirCount: number;
  fileCount: number;
}

async function buildTree(
  ctx: RuntimeCommandContext,
  path: string,
  options: TreeOptions,
  prefix: string,
  depth: number,
): Promise<TreeResult> {
  const result: TreeResult = {
    output: "",
    stderr: "",
    dirCount: 0,
    fileCount: 0,
  };

  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);

  try {
    const stat = await ctx.fs.stat(fullPath);
    if (!stat.isDirectory) {
      // Single file
      result.output = `${path}\n`;
      result.fileCount = 1;
      return result;
    }
  } catch {
    result.stderr = `tree: ${path}: No such file or directory\n`;
    return result;
  }

  // Root directory line
  result.output = `${path}\n`;

  // Check depth limit
  if (options.maxDepth !== null && depth >= options.maxDepth) {
    return result;
  }

  // (1ctx walk-links) the root lists as every folder below it does
  const children = await buildTreeRecursive(
    ctx,
    fullPath,
    options,
    prefix,
    depth,
    options.followLinks ? await ancestorsOf(ctx, fullPath, new Set()) : new Set(),
  );
  if (children.unreadable) {
    result.stderr = `tree: ${path}: Permission denied\n`;
    return result; // (1ctx walk-links)
  }
  result.output += children.output; // (1ctx walk-links)
  result.dirCount += children.dirCount;
  result.fileCount += children.fileCount;
  return result;
}

/**
 * (1ctx walk-links) The real paths of the folders a walk is inside, so -l
 * stops at a link back into one of them, as GNU tree does.
 */
async function ancestorsOf(
  ctx: RuntimeCommandContext,
  path: string,
  above: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  try {
    return new Set([...above, await ctx.fs.realpath(path)]);
  } catch {
    return above;
  }
}

interface EntryInfo {
  name: string;
  isDirectory: boolean;
  // (1ctx walk-links) a link is listed with its target, never walked
  // through unless -l
  link?: string;
}

/**
 * (1ctx walk-links) Lists one folder's entries under the command's
 * traversal budget. A link to a folder is shown as `name -> target` and
 * counted as a folder, as GNU tree 2 does, and entered only under -l and
 * only when it leads outside the folders above it.
 */
async function buildTreeRecursive(
  ctx: RuntimeCommandContext,
  path: string,
  options: TreeOptions,
  prefix: string,
  depth: number,
  ancestors: ReadonlySet<string>, // (1ctx walk-links)
): Promise<TreeResult & { unreadable?: boolean }> {
  const result: TreeResult & { unreadable?: boolean } = {
    output: "",
    stderr: "",
    dirCount: 0,
    fileCount: 0,
  };

  // Check depth limit
  if (options.maxDepth !== null && depth >= options.maxDepth) {
    return result;
  }

  options.budget.visit(depth); // (1ctx walk-links)
  let entryInfos: EntryInfo[] = [];
  try {
    const entries = ctx.fs.readdirWithFileTypes // (1ctx walk-links)
      ? await ctx.fs.readdirWithFileTypes(path)
      : (await ctx.fs.readdir(path)).map((name) => ({ name }));
    options.budget.discover(entries.length);
    for (let i = 0; i < entries.length; i += DEFAULT_BATCH_SIZE) {
      const batch = entries.slice(i, i + DEFAULT_BATCH_SIZE);
      const infos = await settleAll(
        batch.map(async (entry): Promise<EntryInfo | null> => {
          const entryPath =
            path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
          try {
            const typed = entry as Partial<DirentEntry>;
            const isLink =
              typed.isSymbolicLink ??
              (await ctx.fs.lstat(entryPath)).isSymbolicLink;
            if (!isLink) {
              const isDirectory =
                typed.isDirectory ??
                (await ctx.fs.stat(entryPath)).isDirectory;
              return { name: entry.name, isDirectory };
            }
            const link = await ctx.fs.readlink(entryPath); // (1ctx walk-links)
            const isDirectory = await ctx.fs
              .stat(entryPath)
              .then((s) => s.isDirectory)
              .catch(() => false);
            return { name: entry.name, isDirectory, link };
          } catch {
            return null;
          }
        }),
      );
      entryInfos.push(...infos.filter((e): e is EntryInfo => e !== null));
    }
  } catch (error) { // (1ctx walk-links)
    if (error instanceof ExecutionLimitError) throw error;
    if (error instanceof ExecutionAbortedError) throw error;
    result.unreadable = true;
    return result;
  }

  // Filter and sort entries // (1ctx walk-links)
  entryInfos = entryInfos.filter((e) => {
    if (!options.showHidden && e.name.startsWith(".")) {
      return false;
    }
    if (options.directoriesOnly && !e.isDirectory) {
      return false;
    }
    return true;
  });
  entryInfos.sort((a, b) => a.name.localeCompare(b.name));

  // Process entries in order (required for tree output format)
  for (let i = 0; i < entryInfos.length; i++) {
    const entry = entryInfos[i];
    const entryPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    const isLast = i === entryInfos.length - 1;
    const connector = isLast ? "`-- " : "|-- ";
    const childPrefix = prefix + (isLast ? "    " : "|   ");
    let displayName = options.fullPath ? entryPath : entry.name;
    if (entry.link !== undefined) displayName += ` -> ${entry.link}`;

    if (!entry.isDirectory) {
      result.fileCount++;
      result.output += `${prefix + connector + displayName}\n`;
      continue;
    }
    result.dirCount++;
    let inner = ancestors;
    if (entry.link !== undefined) {
      if (!options.followLinks) {
        result.output += `${prefix + connector + displayName}\n`;
        continue; // (1ctx walk-links)
      }
      const real = await ctx.fs.realpath(entryPath).catch(() => undefined); // (1ctx walk-links)
      if (real === undefined || ancestors.has(real)) {
        result.output += `${prefix + connector + displayName}  [recursive, not followed]\n`;
        continue;
      }
      inner = new Set([...ancestors, real]);
    } else if (options.followLinks) {
      inner = await ancestorsOf(ctx, entryPath, ancestors);
    }
    result.output += `${prefix + connector + displayName}\n`; // (1ctx walk-links)
    const subResult = await buildTreeRecursive(
      ctx,
      entryPath,
      options,
      childPrefix,
      depth + 1,
      inner,
    );
    result.output += subResult.output;
    result.dirCount += subResult.dirCount;
    result.fileCount += subResult.fileCount;
  }

  return result;
}

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "tree",
  flags: [
    { flag: "-a", type: "boolean" },
    { flag: "-d", type: "boolean" },
    { flag: "-f", type: "boolean" },
    { flag: "-L", type: "value", valueHint: "number" },
    { flag: "-l", type: "boolean" }, // (1ctx walk-links)
  ],
  needsFiles: true,
};
