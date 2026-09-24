/**
 * .gitignore parser for rg
 *
 * Handles:
 * - Simple patterns (*.log, node_modules/)
 * - Negation patterns (!important.log)
 * - Directory-only patterns (build/)
 * - Rooted patterns (/root-only)
 * - Double-star patterns (for matching across directories)
 */

import type { IFileSystem } from "../../fs/interface.js";
import {
  compileIgnoreGlob,
  type GlobMatch,
  type IgnoreGlob,
  matchGlobs,
} from "./globs.js";

/** (1ctx) Which ignore file a parser read: its rank, highest first. */
export type IgnoreKind = "rgignore" | "ignore" | "gitignore" | "explicit";

const RANK: Record<IgnoreKind, number> = {
  rgignore: 0,
  ignore: 1,
  gitignore: 2,
  explicit: 3,
};

export class GitignoreParser {
  private patterns: IgnoreGlob[] = [];
  private basePath: string;
  readonly kind: IgnoreKind;

  constructor(basePath: string = "/", kind: IgnoreKind = "gitignore") {
    this.basePath = basePath;
    this.kind = kind;
  }

  /**
   * Parse .gitignore content and add patterns
   */
  parse(content: string): void {
    for (const line of content.split("\n")) {
      // (1ctx) trailing spaces go unless escaped, and a CR with them
      let trimmed = line.replace(/\r$/, "");
      trimmed = trimmed.replace(/(^|[^\\])\s+$/, "$1");
      if (!trimmed || trimmed.startsWith("#")) continue;
      try {
        // (1ctx) ripgrep's glob rules, braces included
        this.patterns.push(compileIgnoreGlob(trimmed, false, true));
      } catch {
        // a line that is not a glob is skipped, as ripgrep skips it
      }
    }
  }

  /** (1ctx) What the last matching line says of a path. */
  match(relativePath: string, isDirectory: boolean): GlobMatch {
    const path = relativePath.replace(/^\.\//, "").replace(/^\//, "");
    return matchGlobs(this.patterns, path, isDirectory);
  }

  /**
   * Check if a path should be ignored
   */
  matches(relativePath: string, isDirectory: boolean): boolean {
    return this.match(relativePath, isDirectory) === "ignore";
  }

  /**
   * Check if a path is explicitly whitelisted by a negation pattern
   */
  isWhitelisted(relativePath: string, isDirectory: boolean): boolean {
    return this.match(relativePath, isDirectory) === "whitelist";
  }

  /**
   * Get the base path for this gitignore
   */
  getBasePath(): string {
    return this.basePath;
  }
}

function kindOf(filename: string): IgnoreKind {
  if (filename === ".rgignore") return "rgignore";
  if (filename === ".ignore") return "ignore";
  return "gitignore";
}

/**
 * Hierarchical gitignore manager
 *
 * Loads .gitignore and .ignore files from the root down to the current directory,
 * applying patterns in order (child patterns override parent patterns).
 */
export class GitignoreManager {
  private parsers: GitignoreParser[] = [];
  private fs: IFileSystem;
  private skipDotIgnore: boolean;
  private skipVcsIgnore: boolean;
  private loadedDirs = new Set<string>();
  /** (1ctx) --require-git: .gitignore only inside a repository */
  private requireGit: boolean;
  private repos = new Map<string, Promise<boolean>>();

  constructor(
    fs: IFileSystem,
    _rootPath: string,
    skipDotIgnore = false,
    skipVcsIgnore = false,
    requireGit = false,
  ) {
    this.fs = fs;
    this.skipDotIgnore = skipDotIgnore;
    this.skipVcsIgnore = skipVcsIgnore;
    this.requireGit = requireGit;
  }

  /** (1ctx) A .git in the directory or one above it, as ripgrep looks. */
  private inRepo(dir: string): Promise<boolean> {
    let found = this.repos.get(dir);
    if (found === undefined) {
      found = this.fs.exists(this.fs.resolvePath(dir, ".git")).then((here) => {
        if (here) return true;
        const parent = this.fs.resolvePath(dir, "..");
        return parent === dir ? false : this.inRepo(parent);
      });
      this.repos.set(dir, found);
    }
    return found;
  }

  /** (1ctx) The ignore files a directory's own may be. */
  private async namesFor(dir: string): Promise<string[]> {
    const names: string[] = [];
    if (
      !this.skipVcsIgnore &&
      (!this.requireGit || (await this.inRepo(dir)))
    ) {
      names.push(".gitignore");
    }
    if (!this.skipDotIgnore) names.push(".rgignore", ".ignore");
    return names;
  }

  /**
   * Load all .gitignore and .ignore files from root to the specified path
   */
  async load(targetPath: string, noParents = false): Promise<void> {
    // Build list of directories from filesystem root to target
    // ripgrep loads ignore files from all parent directories
    // (1ctx) but for --no-ignore-parent
    const dirs: string[] = [];
    let current = targetPath;

    while (true) {
      dirs.unshift(current);
      if (noParents) break;
      const parent = this.fs.resolvePath(current, "..");
      if (parent === current) break; // Reached filesystem root
      current = parent;
    }

    // Load ignore files from each directory
    // ripgrep loads them in order: .gitignore, then .rgignore, then .ignore
    // --no-ignore-dot skips .rgignore and .ignore
    // --no-ignore-vcs skips .gitignore
    for (const dir of dirs) {
      this.loadedDirs.add(dir);
      for (const filename of await this.namesFor(dir)) {
        const ignorePath = this.fs.resolvePath(dir, filename);
        try {
          const content = await this.fs.readFile(ignorePath);
          const parser = new GitignoreParser(dir, kindOf(filename));
          parser.parse(content);
          this.parsers.push(parser);
        } catch {
          // No ignore file in this directory
        }
      }
    }
  }

  /**
   * Load ignore files for a directory during traversal.
   * Only loads if the directory hasn't been loaded before.
   */
  async loadForDirectory(dir: string): Promise<void> {
    if (this.loadedDirs.has(dir)) return;
    this.loadedDirs.add(dir);

    for (const filename of await this.namesFor(dir)) {
      const ignorePath = this.fs.resolvePath(dir, filename);
      try {
        const content = await this.fs.readFile(ignorePath);
        const parser = new GitignoreParser(dir, kindOf(filename));
        parser.parse(content);
        this.parsers.push(parser);
      } catch {
        // No ignore file in this directory
      }
    }
  }

  /**
   * Add patterns from raw content at the specified base path.
   * Used for --ignore-file flag.
   */
  addPatternsFromContent(content: string, basePath: string): void {
    const parser = new GitignoreParser(basePath, "explicit");
    parser.parse(content);
    this.parsers.push(parser);
  }

  /**
   * (1ctx) What the ignore files say of a path, as ripgrep weighs them:
   * .rgignore over .ignore over .gitignore over --ignore-file, and within
   * each the deepest directory's file first.
   */
  match(absolutePath: string, isDirectory: boolean): GlobMatch {
    const ordered = [...this.parsers].sort(
      (a, b) =>
        RANK[a.kind] - RANK[b.kind] ||
        b.getBasePath().length - a.getBasePath().length,
    );
    for (const parser of ordered) {
      const basePath = parser.getBasePath();
      const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
      if (absolutePath !== basePath && !absolutePath.startsWith(prefix)) {
        continue;
      }
      const found = parser.match(
        absolutePath.slice(prefix.length),
        isDirectory,
      );
      if (found !== "none") return found;
    }
    return "none";
  }

  /**
   * Check if a path should be ignored
   */
  matches(absolutePath: string, isDirectory: boolean): boolean {
    return this.match(absolutePath, isDirectory) === "ignore";
  }

  /**
   * Check if a path is explicitly whitelisted by a negation pattern.
   */
  isWhitelisted(absolutePath: string, isDirectory: boolean): boolean {
    return this.match(absolutePath, isDirectory) === "whitelist";
  }

  /**
   * Quick check for common ignored directories
   * Used for early pruning during traversal
   */
  static isCommonIgnored(name: string): boolean {
    // Only include VCS directories and very common dependency directories
    // that are almost never searched. Don't include build/dist/target
    // as these are often legitimately searched or have negation patterns.
    const common = new Set([
      "node_modules",
      ".git",
      ".svn",
      ".hg",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      "venv",
      ".venv",
      ".next",
      ".nuxt",
      ".cargo",
    ]);
    return common.has(name);
  }
}

/**
 * Load gitignore files for a search starting at the given path
 */
export async function loadGitignores(
  fs: IFileSystem,
  startPath: string,
  {
    skipDotIgnore = false,
    skipVcsIgnore = false,
    customIgnoreFiles = [],
    noParents = false,
    requireGit = false,
  }: {
    skipDotIgnore?: boolean;
    skipVcsIgnore?: boolean;
    customIgnoreFiles?: string[];
    /** (1ctx) --no-ignore-parent */
    noParents?: boolean;
    /** (1ctx) --require-git */
    requireGit?: boolean;
  } = {},
): Promise<GitignoreManager> {
  const manager = new GitignoreManager(
    fs,
    startPath,
    skipDotIgnore,
    skipVcsIgnore,
    requireGit,
  );
  await manager.load(startPath, noParents);

  // Load custom ignore files (--ignore-file)
  for (const ignoreFile of customIgnoreFiles) {
    try {
      const absolutePath = fs.resolvePath(startPath, ignoreFile);
      const content = await fs.readFile(absolutePath);
      // Add patterns from custom ignore file at the root level
      manager.addPatternsFromContent(content, startPath);
    } catch {
      // Ignore missing files
    }
  }

  return manager;
}
