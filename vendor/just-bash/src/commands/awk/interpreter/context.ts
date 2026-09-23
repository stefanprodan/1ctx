/**
 * AWK Runtime Context
 *
 * Holds all state for AWK program execution.
 */

import { ConstantRegex, type RegexLike } from "../../../regex/index.js";
import type { FeatureCoverageWriter } from "../../../types.js";
import type { AwkFunctionDef } from "../ast.js";
import type { InputStream } from "./input.js";
import type { AwkFileSystem, AwkValue } from "./types.js";

const DEFAULT_MAX_ITERATIONS = 10000;
// Keep low to prevent JS stack overflow (each AWK call uses ~10-20 JS stack frames)
const DEFAULT_MAX_RECURSION_DEPTH = 100;
// Default field separator for AWK (whitespace)
const DEFAULT_FIELD_SEP = new ConstantRegex(/\s+/);

export interface AwkRuntimeContext {
  // Built-in variables
  FS: string;
  OFS: string;
  ORS: string;
  OFMT: string;
  NR: number;
  NF: number;
  FNR: number;
  FILENAME: string;
  RSTART: number;
  RLENGTH: number;
  SUBSEP: string;
  // (1ctx) the record separator and the text that ended the last record
  RS: string;
  RT: string;

  // Current line data
  fields: string[];
  line: string;

  // User variables and arrays
  vars: Record<string, AwkValue>;
  arrays: Record<string, Record<string, AwkValue>>;
  // Array aliases for function parameter passing (parameter name → original name)
  arrayAliases: Map<string, string>;

  // ARGC/ARGV for command line arguments
  ARGC: number;
  ARGV: Record<string, string>;

  // ENVIRON for environment variables
  ENVIRON: Record<string, string>;

  // User-defined functions (from AST)
  functions: Map<string, AwkFunctionDef>;

  // (1ctx) the main input walk, read by the main loop and plain getline
  mainInput?: { nextRecord(): Promise<string | null>; skipFile(): void };
  // (1ctx) one input byte budget shared by every stream
  maxInputBytes: number;
  inputBytes: number;
  /** Internal getline streams, isolated from the AWK variable namespace. */
  getlineCommandStreams: Map<string, InputStream>;
  getlineFileStreams: Map<string, InputStream>;
  fieldSep: RegexLike;

  // Execution limits
  maxIterations: number;
  maxRecursionDepth: number;
  maxOutputSize: number;
  maxArrayElements: number;
  arrayElementCount: number;
  recordsProcessed: number;
  currentRecursionDepth: number;

  // Control flow
  exitCode: number;
  shouldExit: boolean;
  shouldNext: boolean;
  shouldNextFile: boolean;
  loopBreak: boolean;
  loopContinue: boolean;
  returnValue?: AwkValue;
  hasReturn: boolean;
  inEndBlock: boolean; // Track if we're executing END blocks (for exit behavior)

  // Output buffer (stdout)
  output: string;

  // Filesystem access for getline < file and print > file
  fs?: AwkFileSystem;
  cwd?: string;

  // Track which files have been opened with > (for overwrite-then-append behavior)
  openedFiles: Set<string>;

  // Random function override for testing
  random?: () => number;

  // Exec function for command pipe getline ("cmd" | getline)
  exec?: (
    cmd: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

  // Feature coverage writer for fuzzing instrumentation
  coverage?: FeatureCoverageWriter;

  // (1ctx) the command's abort signal, checked by the record reader
  signal?: AbortSignal;

  // Defense context invariant flag propagated from RuntimeCommandContext
  requireDefenseContext?: boolean;
}

export interface CreateContextOptions {
  fieldSep?: RegexLike;
  maxIterations?: number;
  maxRecursionDepth?: number;
  maxOutputSize?: number;
  maxArrayElements?: number;
  maxInputBytes?: number;
  fs?: AwkFileSystem;
  cwd?: string;
  exec?: (
    cmd: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  coverage?: FeatureCoverageWriter;
  requireDefenseContext?: boolean;
  signal?: AbortSignal;
}

export function createRuntimeContext(
  options: CreateContextOptions = {},
): AwkRuntimeContext {
  const {
    fieldSep = DEFAULT_FIELD_SEP,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxRecursionDepth = DEFAULT_MAX_RECURSION_DEPTH,
    maxOutputSize = 0,
    maxArrayElements = 100_000,
    maxInputBytes = 10 * 1024 * 1024,
    fs,
    cwd,
    exec,
    coverage,
    requireDefenseContext,
    signal,
  } = options;

  // (1ctx) ARGV and ENVIRON are ordinary arrays, so delete, in and for-in
  // reach them; their elements are not counted against the array cap.
  const ARGV = Object.create(null) as Record<string, string>;
  const ENVIRON = Object.create(null) as Record<string, string>;
  const arrays = Object.create(null) as Record<string, Record<string, AwkValue>>;
  arrays.ARGV = ARGV;
  arrays.ENVIRON = ENVIRON;

  return {
    FS: " ",
    OFS: " ",
    ORS: "\n",
    OFMT: "%.6g",
    NR: 0,
    NF: 0,
    FNR: 0,
    FILENAME: "",
    RSTART: 0,
    RLENGTH: -1,
    SUBSEP: "\x1c",
    RS: "\n",
    RT: "",

    fields: [],
    line: "",

    // Use null-prototype objects to prevent prototype pollution
    // when user-controlled keys like "__proto__" or "constructor" are used
    vars: Object.create(null) as Record<string, AwkValue>,
    arrays,
    arrayAliases: new Map(),

    ARGC: 0,
    ARGV,
    ENVIRON,

    functions: new Map(),
    getlineCommandStreams: new Map(),
    getlineFileStreams: new Map(),

    fieldSep,
    maxIterations,
    maxRecursionDepth,
    maxOutputSize,
    maxArrayElements,
    maxInputBytes,
    inputBytes: 0,
    arrayElementCount: 0,
    recordsProcessed: 0,
    currentRecursionDepth: 0,

    exitCode: 0,
    shouldExit: false,
    shouldNext: false,
    shouldNextFile: false,
    loopBreak: false,
    loopContinue: false,
    hasReturn: false,
    inEndBlock: false,

    output: "",
    openedFiles: new Set(),

    fs,
    cwd,
    exec,
    coverage,
    requireDefenseContext,
    signal,
  };
}
