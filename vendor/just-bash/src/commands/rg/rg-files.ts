/**
 * (1ctx) Which files rg searches, moved out of rg-search.ts: the paths in
 * the order given, `-` as stdin, a path given by name searched whatever
 * the filters say, and a walk that weighs -g over the ignore files over
 * the types over hidden names, as ripgrep's walker does.
 */

import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { FileTraversalBudget } from "../../fs/traversal.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { RuntimeCommandContext } from "../../types.js";
import type { FileTypeRegistry } from "./file-types.js";
import { GitignoreManager } from "./gitignore.js";
import type { Overrides } from "./globs.js";
import type { RgOptions } from "./rg-options.js";

/** A file to search: a path, or standard input. */
export interface Haystack {
  path: string;
  stdin?: boolean;
  /** named on the command line, so searched even when binary */
  given?: boolean;
}

export interface Collected {
  files: Haystack[];
  /** a path was a directory or there were several, so names print */
  named: boolean;
  /** ripgrep's line for each path that is not there */
  errors: string[];
}

export interface Filters {
  options: RgOptions;
  gitignore: GitignoreManager | null;
  types: FileTypeRegistry;
  overrides: Overrides;
}

export const STDIN_NAME = "<stdin>";

export function missingPath(path: string): string {
  return `rg: ${path}: IO error for operation on ${path}: No such file or directory (os error 2)`;
}

function byPath(a: Haystack, b: Haystack): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * (1ctx) --sort and --sortr: by path, or by time, which is the file's
 * mtime for every time key, since that is the one time a stat gives.
 */
async function sorted(
  ctx: RuntimeCommandContext,
  files: Haystack[],
  options: RgOptions,
): Promise<Haystack[]> {
  if (options.sort === "none") return files;
  let order = byPath;
  if (options.sort !== "path") {
    const times = new Map<string, number>();
    for (const file of files) {
      let time = 0;
      try {
        const stat = await ctx.fs.stat(ctx.fs.resolvePath(ctx.cwd, file.path));
        time = stat.mtime.getTime();
      } catch (error) {
        rethrowFatalExecutionError(error);
      }
      times.set(file.path, time);
    }
    order = (a, b) =>
      (times.get(a.path) ?? 0) - (times.get(b.path) ?? 0) || byPath(a, b);
  }
  files.sort(order);
  if (options.sortReverse) files.reverse();
  return files;
}

export async function collectFiles(
  ctx: RuntimeCommandContext,
  paths: string[],
  filters: Filters,
  /** no path was given: the directory, its names shown without ./ */
  implicit = false,
): Promise<Collected> {
  const files: Haystack[] = [];
  const errors: string[] = [];
  const budget = new FileTraversalBudget({
    limits: ctx.limits,
    signal: ctx.signal,
    executionScope: ctx.executionScope,
    site: "rg",
  });
  let named = !implicit && paths.length > 1;
  const push = (file: Haystack) => {
    if (files.length >= ctx.limits.maxArrayElements) {
      throw new ExecutionLimitError(
        `rg: file collection limit exceeded (${ctx.limits.maxArrayElements})`,
        "array_elements",
      );
    }
    files.push(file);
  };

  for (const path of implicit ? ["."] : paths) {
    budget.checkpoint();
    if (path === "-") {
      push({ path: STDIN_NAME, stdin: true, given: true });
      continue;
    }
    const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
    let stat: Awaited<ReturnType<typeof ctx.fs.stat>>;
    try {
      stat = await ctx.fs.stat(fullPath);
    } catch (error) {
      rethrowFatalExecutionError(error);
      errors.push(missingPath(path));
      continue;
    }
    if (stat.isFile) {
      // a path given by name is searched whatever the filters say
      push({ path, given: true });
    } else if (stat.isDirectory) {
      named = true;
      const found: Haystack[] = [];
      const shown = implicit ? "" : path;
      await walkDirectory(ctx, shown, fullPath, 0, filters, found, budget);
      for (const file of await sorted(ctx, found, filters.options)) push(file);
    }
  }
  return { files, named, errors };
}

/** The path a glob sees: relative to the directory rg runs in. */
function globPath(ctx: RuntimeCommandContext, absolute: string, shown: string) {
  const root = ctx.cwd.endsWith("/") ? ctx.cwd : `${ctx.cwd}/`;
  return absolute.startsWith(root) ? absolute.slice(root.length) : shown;
}

/** Whether a walked entry is kept: -g, then ignore files, types, hidden. */
function keep(
  ctx: RuntimeCommandContext,
  filters: Filters,
  shown: string,
  absolute: string,
  name: string,
  isDirectory: boolean,
): boolean {
  const { options, gitignore, types, overrides } = filters;
  const override = overrides.match(
    globPath(ctx, absolute, shown),
    isDirectory,
  );
  if (override === "ignore") return false;
  if (override === "whitelist") return true;
  const ignored = gitignore?.match(absolute, isDirectory) ?? "none";
  if (ignored === "ignore") return false;
  let whitelisted = ignored === "whitelist";
  if (!isDirectory) {
    if (options.types.length > 0) {
      if (!types.matchesType(name, options.types)) return false;
      whitelisted = true;
    }
    if (
      options.typesNot.length > 0 &&
      types.matchesType(name, options.typesNot)
    ) {
      return false;
    }
  }
  return whitelisted || options.hidden || !name.startsWith(".");
}

async function walkDirectory(
  ctx: RuntimeCommandContext,
  relativePath: string,
  absolutePath: string,
  depth: number,
  filters: Filters,
  files: Haystack[],
  budget: FileTraversalBudget,
  activeDirectories = new Set<string>(),
): Promise<void> {
  const { options, gitignore } = filters;
  if (depth >= options.maxDepth) {
    return;
  }
  budget.visit(depth);

  let directoryIdentity: string | undefined;
  if (options.followSymlinks) {
    try {
      const stat = await ctx.fs.stat(absolutePath);
      directoryIdentity =
        stat.identity !== undefined
          ? `identity:${stat.identity}`
          : stat.dev !== undefined && stat.ino !== undefined
            ? `inode:${String(stat.dev)}:${String(stat.ino)}`
            : `path:${await ctx.fs.realpath(absolutePath)}`;
      if (activeDirectories.has(directoryIdentity)) return;
      activeDirectories.add(directoryIdentity);
    } catch (error) {
      rethrowFatalExecutionError(error);
      return;
    }
  }

  // Load ignore files for this directory (per-directory ignore loading)
  if (gitignore) {
    await gitignore.loadForDirectory(absolutePath);
  }

  try {
    const entries = ctx.fs.readdirWithFileTypes
      ? await ctx.fs.readdirWithFileTypes(absolutePath)
      : (await ctx.fs.readdir(absolutePath)).map((name) => ({
          name,
          isFile: undefined as boolean | undefined,
        }));

    for (const entry of entries) {
      budget.checkpoint();
      const name = entry.name;

      // Skip common ignored directories (VCS, node_modules, etc.)
      if (!options.noIgnore && GitignoreManager.isCommonIgnored(name)) {
        continue;
      }

      // (1ctx) no ./ when no path was given, kept when "." was
      const entryRelativePath =
        relativePath === ""
          ? name
          : relativePath.endsWith("/")
            ? `${relativePath}${name}`
            : `${relativePath}/${name}`;
      const entryAbsolutePath = ctx.fs.resolvePath(absolutePath, name);

      let isFile: boolean;
      let isDirectory: boolean;
      const hasTypeInfo = entry.isFile !== undefined && "isDirectory" in entry;
      try {
        let isSymlink: boolean;
        if (hasTypeInfo) {
          const dirent = entry as {
            isFile: boolean;
            isDirectory: boolean;
            isSymbolicLink?: boolean;
          };
          isSymlink = dirent.isSymbolicLink === true;
          isFile = dirent.isFile;
          isDirectory = dirent.isDirectory;
        } else {
          const lstat = ctx.fs.lstat
            ? await ctx.fs.lstat(entryAbsolutePath)
            : await ctx.fs.stat(entryAbsolutePath);
          isSymlink = lstat.isSymbolicLink === true;
          isFile = lstat.isFile;
          isDirectory = lstat.isDirectory;
        }
        // Skip symlinks unless -L is specified; with it, stat the target
        if (isSymlink) {
          if (!options.followSymlinks) continue;
          const stat = await ctx.fs.stat(entryAbsolutePath);
          isFile = stat.isFile;
          isDirectory = stat.isDirectory;
        }
      } catch {
        continue;
      }

      if (
        !keep(
          ctx,
          filters,
          entryRelativePath,
          entryAbsolutePath,
          name,
          isDirectory,
        )
      ) {
        continue;
      }

      if (isDirectory) {
        await walkDirectory(
          ctx,
          entryRelativePath,
          entryAbsolutePath,
          depth + 1,
          filters,
          files,
          budget,
          activeDirectories,
        );
      } else if (isFile) {
        budget.visit(depth + 1);
        if (options.maxFilesize > 0) {
          try {
            const fileStat = await ctx.fs.stat(entryAbsolutePath);
            if (fileStat.size > options.maxFilesize) continue;
          } catch {
            continue;
          }
        }
        if (files.length >= ctx.limits.maxArrayElements) {
          throw new ExecutionLimitError(
            `rg: file collection limit exceeded (${ctx.limits.maxArrayElements})`,
            "array_elements",
          );
        }
        files.push({ path: entryRelativePath });
      }
    }
  } catch (error) {
    rethrowFatalExecutionError(error);
    // Directory read failed - skip
  } finally {
    if (directoryIdentity !== undefined) {
      activeDirectories.delete(directoryIdentity);
    }
  }
}
