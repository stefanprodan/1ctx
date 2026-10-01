/**
 * AWK Runtime Context
 *
 * Holds all state for AWK program execution.
 */

import type { UserRegex } from "../../../regex/index.js";
import { type FieldSeparator, SPACE_SEPARATOR } from "./fields.js";
import type { FeatureCoverageWriter } from "../../../types.js";
import type { AwkFunctionDef } from "../ast.js";
import { utf8ByteLength } from "../../../encoding.js";
import type { OutputFile } from "./files.js";
import type { InputStream } from "./input.js";
import type { AwkFileSystem, AwkValue } from "./types.js";

const DEFAULT_MAX_ITERATIONS = 10000;
// Keep low to prevent JS stack overflow (each AWK call uses ~10-20 JS stack frames)
const DEFAULT_MAX_RECURSION_DEPTH = 100;

export interface AwkRuntimeContext {
  // Built-in variables
  FS: string;
  OFS: string;
  ORS: string;
  OFMT: string;
  // (1ctx awk-numbers) the format of a number converted to a string
  CONVFMT: string;
  NR: number;
  NF: number;
  FNR: number;
  FILENAME: string;
  RSTART: number;
  RLENGTH: number;
  SUBSEP: string;
  // (1ctx awk-records) the record separator and the text that ended the last record
  RS: string;
  RT: string;

  // Current line data
  fields: string[];
  line: string;

  // User variables and arrays
  vars: Record<string, AwkValue>;
  // (1ctx awk-compare) an element made by a reference holds undefined until it is
  // assigned: it reads as "" and compares as gawk's uninitialized value
  arrays: Record<string, Record<string, AwkValue | undefined>>;
  // Array aliases for function parameter passing (parameter name → original name)
  arrayAliases: Map<string, string>;

  // ARGC/ARGV for command line arguments
  ARGC: number;
  ARGV: Record<string, string>;

  // ENVIRON for environment variables
  ENVIRON: Record<string, string>;

  // User-defined functions (from AST)
  functions: Map<string, AwkFunctionDef>;

  // (1ctx awk-records) the main input walk, read by the main loop and plain getline
  mainInput?: { nextRecord(): Promise<string | null>; skipFile(): void };
  // (1ctx awk-options) standard input, once; empty after the first read
  readStdin?: () => string;
  // (1ctx awk-records) one input byte budget shared by every stream
  maxInputBytes: number;
  inputBytes: number;
  /** Internal getline streams, isolated from the AWK variable namespace. */
  getlineCommandStreams: Map<string, InputStream>;
  getlineFileStreams: Map<string, InputStream>;
  fieldSep: FieldSeparator;

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
  // (1ctx awk-std-streams) what the program printed to /dev/stderr
  errorOutput: string;
  // (1ctx awk-pipes) the output pipes by command, in the order opened, each holding
  // the text printed to it, run when closed or when the program ends;
  // flushedAt marks how much of the output a pipe's stdout must follow
  outputPipes: Map<string, string>;
  pipeBytes: number;
  flushedAt: number;
  // (1ctx awk-output-files) the output's UTF-8 length, kept as it grows so printf never
  // measures the whole output
  outputBytes: number;

  // Filesystem access for getline < file and print > file
  fs?: AwkFileSystem;
  cwd?: string;

  // (1ctx awk-output-files) the open output files by path, their text held until a flush
  openedFiles: Map<string, OutputFile>;
  // (1ctx awk-output-files) the open files holding text, so a flush never walks them all
  heldFiles: Set<string>;

  // Random function override for testing
  random?: () => number;

  // Exec function for command pipe getline ("cmd" | getline)
  // (1ctx awk-pipes) stdin carries an output pipe's text to its command
  exec?: (
    cmd: string,
    stdin?: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

  // Feature coverage writer for fuzzing instrumentation
  coverage?: FeatureCoverageWriter;

  // (1ctx awk-records) the command's abort signal, checked by the record reader
  signal?: AbortSignal;
  // (1ctx awk-caps) the regex record separators this command compiled
  separators: Map<string, UserRegex>;

  // Defense context invariant flag propagated from RuntimeCommandContext
  requireDefenseContext?: boolean;
}

export interface CreateContextOptions {
  fieldSep?: FieldSeparator;
  maxIterations?: number;
  maxRecursionDepth?: number;
  maxOutputSize?: number;
  maxArrayElements?: number;
  maxInputBytes?: number;
  fs?: AwkFileSystem;
  cwd?: string;
  // (1ctx awk-pipes) stdin carries an output pipe's text to its command
  exec?: (
    cmd: string,
    stdin?: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  coverage?: FeatureCoverageWriter;
  requireDefenseContext?: boolean;
  signal?: AbortSignal;
}

export function createRuntimeContext(
  options: CreateContextOptions = {},
): AwkRuntimeContext {
  const {
    fieldSep = SPACE_SEPARATOR,
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

  // (1ctx awk-options) ARGV and ENVIRON are ordinary arrays, so delete, in and for-in
  // reach them; whoever fills them counts their elements.
  const ARGV = Object.create(null) as Record<string, string>;
  const ENVIRON = Object.create(null) as Record<string, string>;
  const arrays = Object.create(null) as AwkRuntimeContext["arrays"];
  arrays.ARGV = ARGV;
  arrays.ENVIRON = ENVIRON;

  return {
    FS: " ",
    OFS: " ",
    ORS: "\n",
    OFMT: "%.6g",
    CONVFMT: "%.6g",
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
    errorOutput: "",
    outputPipes: new Map(),
    pipeBytes: 0,
    flushedAt: 0,
    outputBytes: 0,
    openedFiles: new Map(),
    heldFiles: new Set(),

    fs,
    cwd,
    exec,
    coverage,
    requireDefenseContext,
    signal,
    separators: new Map(),
  };
}

/**
 * (1ctx awk-output-files) Adds text to the output and its UTF-8 length. A high surrogate
 * at the end and a low one at the start are one code point once joined.
 */
export function addOutput(ctx: AwkRuntimeContext, text: string): void {
  const last = ctx.output.charCodeAt(ctx.output.length - 1);
  const first = text.charCodeAt(0);
  ctx.output += text;
  ctx.outputBytes += utf8ByteLength(text);
  if (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) {
    ctx.outputBytes -= 2;
  }
}
