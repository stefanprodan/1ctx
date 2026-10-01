/**
 * RgOptions interface and default values
 */

export interface RgOptions {
  // Pattern matching
  ignoreCase: boolean;
  caseSensitive: boolean;
  smartCase: boolean;
  fixedStrings: boolean;
  wordRegexp: boolean;
  lineRegexp: boolean;
  invertMatch: boolean;
  multiline: boolean;
  multilineDotall: boolean;
  patterns: string[];
  patternFiles: string[];

  // Output control
  count: boolean;
  countMatches: boolean;
  files: boolean;
  filesWithMatches: boolean;
  filesWithoutMatch: boolean;
  stats: boolean;
  onlyMatching: boolean;
  maxCount: number;
  lineNumber: boolean;
  noFilename: boolean;
  withFilename: boolean;
  nullSeparator: boolean;
  /** (1ctx rg-parser) --null-data: NUL ends a line, and no file is binary */
  nullData: boolean;
  byteOffset: boolean;
  column: boolean;
  vimgrep: boolean;
  replace: string | null;
  afterContext: number;
  beforeContext: number;
  /** (1ctx rg-parser) null with --no-context-separator */
  contextSeparator: string | null;
  /** (1ctx rg-parser) after the name, number and column of a context line */
  fieldContextSeparator: string;
  /** (1ctx rg-parser) after the name, number and column of a matching line */
  fieldMatchSeparator: string;
  quiet: boolean;
  heading: boolean;
  passthru: boolean;
  includeZero: boolean;
  sort: SortKey;
  /** (1ctx rg-parser) --sortr: the same keys, descending */
  sortReverse: boolean;
  json: boolean;
  /** (1ctx rg-output) -M: longer lines are omitted, 0 for no limit */
  maxColumns: number;
  /** (1ctx rg-output) --max-columns-preview: their start is shown */
  maxColumnsPreview: boolean;
  /** (1ctx rg-output) --trim: leading ASCII whitespace dropped from printed lines */
  trim: boolean;
  /** (1ctx rg-output) --path-separator: written in place of / in printed paths */
  pathSeparator: string | null;
  /** (1ctx rg-parser) --no-messages: no error lines, the exit code kept */
  noMessages: boolean;
  /** (1ctx rg-output) --crlf: a line's final \r is not matched */
  crlf: boolean;
  /** (1ctx rg-regex) -P, --pcre2, --engine pcre2: grep -P's layer on RE2 */
  pcre: boolean;
  /** (1ctx rg-regex) --no-unicode: \w, \d and \s are ASCII */
  unicode: boolean;
  /** (1ctx rg-types) --type-list */
  typeList: boolean;
  /** (1ctx rg-parser) -V and --version */
  version: "short" | "long" | null;

  // File selection
  globs: string[];
  iglobs: string[]; // case-insensitive globs
  globCaseInsensitive: boolean; // make all globs case-insensitive
  types: string[];
  typesNot: string[];
  /** (1ctx rg-types) --type-add and --type-clear in the order given */
  typeChanges: TypeChange[];
  hidden: boolean;
  noIgnore: boolean;
  noIgnoreDot: boolean;
  noIgnoreVcs: boolean;
  /** (1ctx rg-parser) no ignore files from the directories above the search */
  noIgnoreParent: boolean;
  /** (1ctx rg-parser) --no-ignore-files: --ignore-file is not read */
  noIgnoreFiles: boolean;
  /** (1ctx rg-globs) .gitignore only inside a git repository */
  requireGit: boolean;
  ignoreFiles: string[]; // custom ignore files via --ignore-file
  maxDepth: number;
  maxFilesize: number; // in bytes, 0 = explicitly unlimited
  followSymlinks: boolean;
  searchZip: boolean;
  searchBinary: boolean;
  /** (1ctx rg-output) --binary and -uuu: binary files in a walk are searched too */
  binary: boolean;
  preprocessor: string | null; // --pre command
  preprocessorGlobs: string[]; // --pre-glob patterns
}

/** (1ctx rg-globs) ripgrep's sort keys; the times are all the file's mtime here */
export type SortKey = "path" | "none" | "modified" | "accessed" | "created";

export interface TypeChange {
  kind: "add" | "clear";
  value: string;
}

export function createDefaultOptions(): RgOptions {
  return {
    ignoreCase: false,
    caseSensitive: false,
    // (1ctx rg-defaults) case-sensitive and no line numbers, as ripgrep when piped
    smartCase: false,
    fixedStrings: false,
    wordRegexp: false,
    lineRegexp: false,
    invertMatch: false,
    multiline: false,
    multilineDotall: false,
    patterns: [],
    patternFiles: [],
    count: false,
    countMatches: false,
    files: false,
    filesWithMatches: false,
    filesWithoutMatch: false,
    stats: false,
    onlyMatching: false,
    // (1ctx search-counts) no limit; -m 0 selects nothing
    maxCount: -1,
    lineNumber: false,
    noFilename: false,
    withFilename: false,
    nullSeparator: false,
    nullData: false,
    byteOffset: false,
    column: false,
    vimgrep: false,
    replace: null,
    afterContext: 0,
    beforeContext: 0,
    contextSeparator: "--",
    fieldContextSeparator: "-",
    fieldMatchSeparator: ":",
    quiet: false,
    heading: false,
    passthru: false,
    includeZero: false,
    sort: "path",
    sortReverse: false,
    json: false,
    maxColumns: 0,
    maxColumnsPreview: false,
    trim: false,
    pathSeparator: null,
    noMessages: false,
    crlf: false,
    pcre: false,
    unicode: true,
    typeList: false,
    version: null,
    globs: [],
    iglobs: [],
    globCaseInsensitive: false,
    types: [],
    typesNot: [],
    typeChanges: [],
    hidden: false,
    noIgnore: false,
    noIgnoreDot: false,
    noIgnoreVcs: false,
    noIgnoreParent: false,
    noIgnoreFiles: false,
    requireGit: false,
    ignoreFiles: [],
    maxDepth: 256,
    // Keep the default liberal but finite so a plain recursive search cannot
    // read an arbitrarily large single file before command budgets apply.
    maxFilesize: 512 * 1024 * 1024,
    followSymlinks: false,
    searchZip: false,
    searchBinary: false,
    binary: false,
    preprocessor: null,
    preprocessorGlobs: [],
  };
}
