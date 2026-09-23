/**
 * yq - RuntimeCommand-line YAML/XML/INI/CSV/TOML processor
 *
 * Uses jq-style query expressions to process YAML, XML, INI, CSV, and TOML files.
 * Shares the query engine with jq for consistent filtering behavior.
 *
 * Inspired by mikefarah/yq (https://github.com/mikefarah/yq)
 * This is a reimplementation for the just-bash sandboxed environment.
 */

import { BoundedStringBuilder } from "../../bounded-builder.js";
import { decodeBytesToUtf8 } from "../../encoding.js";
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import {
  assertDefenseContext,
  awaitWithDefenseContext,
} from "../../security/defense-context.js";
import { SecurityViolationError } from "../../security/defense-in-depth-box.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import type YAML from "yaml";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";
import {
  type EvaluateOptions,
  parse,
  type QuerySource,
  type QueryValue,
} from "../query-engine/index.js";
import { stripsComments } from "../query-engine/builtins/dialect-builtins.js";
import type { AstNode } from "../query-engine/parser.js";
import { getValueDepth } from "../query-engine/value-operations.js";
import {
  defaultFormatOptions,
  detectFormatFromExtension,
  extractFrontMatter,
  type FormatOptions,
  formatOutput,
  type InputFormat as InputFormatName,
  isValidInputFormat,
  isValidOutputFormat,
  parseAllYamlDocuments,
  parseInput,
} from "./formats.js";
import { evaluateAll, evaluateDocument, type Input } from "./documents.js";
import { hasAlias, preservingText, spelledFor11 } from "./preserve.js";

const yqHelp = {
  name: "yq",
  summary: "command-line YAML/XML/INI/CSV/TOML processor",
  usage: "yq [OPTIONS] [FILTER] [FILE]",
  description: `yq uses jq-style expressions to query and transform data in various formats.
Supports YAML, JSON, XML, INI, CSV, and TOML with automatic format conversion.

EXAMPLES:
  # Extract a value from YAML
  yq '.name' config.yaml
  yq '.users[0].email' data.yaml

  # Filter arrays
  yq '.items[] | select(.active == true)' data.yaml
  yq '[.users[] | select(.age > 30)]' users.yaml

  # Transform data
  yq '.users | map({name, email})' data.yaml
  yq '.items | sort_by(.price) | reverse' products.yaml

  # Modify file in-place
  yq -i '.version = "2.0"' config.yaml

  # Read JSON, output YAML
  yq -p json '.' config.json

  # Read YAML, output JSON
  yq -o json '.' config.yaml
  yq -o json -c '.' config.yaml  # compact JSON

  # Parse TOML config files
  yq '.package.name' Cargo.toml
  yq -o json '.' pyproject.toml

  # Parse XML (attributes use +@ prefix, text uses +content)
  yq -p xml '.root.items.item[].name' data.xml
  yq -p xml '.root.user["+@id"]' data.xml  # XML attributes

  # Parse INI config files
  yq -p ini '.database.host' config.ini
  yq -p ini '.server' config.ini -o json

  # Parse CSV/TSV (auto-detects delimiter)
  yq -p csv '.[0].name' data.csv
  yq '.[0].name' data.tsv              # auto-detected as CSV
  yq -p csv '[.[] | select(.category == "A")]' data.csv

  # Extract front-matter from markdown/content files
  yq --front-matter '.title' post.md

  # Convert between formats
  yq -p json -o csv '.users' data.json   # JSON to CSV
  yq -p csv -o yaml '.' data.csv         # CSV to YAML
  yq -p ini -o json '.' config.ini       # INI to JSON
  yq -p xml -o json '.' data.xml         # XML to JSON
  yq -o toml '.' config.yaml             # YAML to TOML

  # Common jq functions work in yq:
  yq 'keys' data.yaml                    # get object keys
  yq 'length' data.yaml                  # array/string length
  yq '.items | first' data.yaml          # first element
  yq '.items | last' data.yaml           # last element
  yq '.nums | add' data.yaml             # sum numbers
  yq '.nums | min' data.yaml             # minimum
  yq '.nums | max' data.yaml             # maximum
  yq '.items | unique' data.yaml         # unique values
  yq '.items | group_by(.type)' data.yaml`,
  options: [
    "-p, --input-format=FMT   input format: yaml (default), xml, json, ini, csv, toml",
    "-o, --output-format=FMT  output format: yaml (default), json, xml, ini, csv, tsv, props, toml",
    "-i, --inplace            modify file in-place",
    "-r, --raw-output         output strings without quotes (json only)",
    "-c, --compact            compact output (json only)",
    "-e, --exit-status        set exit status based on output",
    "-s, --slurp              read entire input into array",
    "-n, --null-input         don't read any input",
    "-j, --tojson             JSON output, the same as -o json",
    "-N, --no-doc             no --- between the results of different documents",
    "-0, --nul-output         end each result with a NUL",
    "    eval-all, ea         run the filter once over every document of every file",
    "-f, --front-matter       extract and process front-matter only",
    "-P, --prettyPrint        pretty print output",
    "-I, --indent=N           set indent level (default: 2)",
    "    --xml-attribute-prefix=STR  XML attribute prefix (default: +@)",
    "    --xml-content-name=STR  XML text content name (default: +content)",
    "    --csv-delimiter=CHAR CSV delimiter (default: auto-detect)",
    "    --csv-header         CSV has header row (default: true)",
    "    --help               display this help and exit",
  ],
};

function parseIndent(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const indent = Number(value);
  if (!Number.isSafeInteger(indent) || indent < 0 || indent > 32) return null;
  return indent;
}

function invalidIndent(value: string | undefined): ExecResult {
  return {
    stdout: "",
    stderr: `yq: invalid indent '${value ?? ""}' (expected integer 0..32)\n`,
    exitCode: 2,
  };
}

type RunOne = (
  args: string[],
  ctx: RuntimeCommandContext,
  file: number,
) => Promise<ExecResult>;

// the keys of a run's first and last result, for the --- between files
const edges = new WeakMap<ExecResult, [Key, Key]>();

const TOJSON_WARNING =
  "Flag --tojson has been deprecated, please use -o=json instead\n";

interface YqOptions extends FormatOptions {
  exitStatus: boolean;
  slurp: boolean;
  nullInput: boolean;
  /** no --- between documents, mikefarah's -N (1ctx) */
  noDoc: boolean;
  /** -j, mikefarah's deprecated --tojson (1ctx) */
  tojson: boolean;
  /** -0: a NUL after each result, mikefarah's --nul-output (1ctx) */
  nulOutput: boolean;
  inplace: boolean;
  frontMatter: boolean;
  /** ea: the filter runs once over every document (1ctx) */
  evalAll: boolean;
}

interface ParsedArgs {
  options: YqOptions;
  filter: string;
  files: string[];
  /** where each file sits in args, to run one file at a time (1ctx) */
  fileAt: number[];
  inputFormatExplicit: boolean;
  outputFormatExplicit: boolean;
}

// mikefarah's one-letter formats: -oj, -o y (1ctx)
const SHORT_FORMATS: Record<string, string> = Object.assign(Object.create(null), {
  y: "yaml",
  j: "json",
  x: "xml",
  c: "csv",
  t: "tsv",
  p: "props",
});

function formatName(value: string | undefined): string | undefined {
  return value === undefined ? value : (SHORT_FORMATS[value] ?? value);
}

function parseArgs(args: string[]): ParsedArgs | ExecResult {
  const options: YqOptions = {
    ...defaultFormatOptions,
    exitStatus: false,
    slurp: false,
    nullInput: false,
    noDoc: false,
    tojson: false,
    nulOutput: false,
    inplace: false,
    frontMatter: false,
    evalAll: false,
  };
  let inputFormatExplicit = false;
  let outputFormatExplicit = false;

  let filter = ".";
  let filterSet = false;
  let command = false;
  const files: string[] = [];
  const fileAt: number[] = [];
  // after --, the filter and files only, as mikefarah reads them (1ctx)
  let positional = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (!positional && a === "--") {
      positional = true;
      continue;
    }
    if (positional) {
      if (filterSet) {
        files.push(a);
        fileAt.push(i);
      } else {
        filter = a;
        filterSet = true;
      }
      continue;
    }

    // Long options with values
    if (a.startsWith("--input-format=")) {
      const format = formatName(a.slice(15));
      if (!isValidInputFormat(format)) {
        return unknownOption("yq", `--input-format=${format}`);
      }
      options.inputFormat = format;
      inputFormatExplicit = true;
    } else if (a.startsWith("--output-format=")) {
      const format = formatName(a.slice(16));
      outputFormatExplicit = true;
      if (!isValidOutputFormat(format)) {
        return unknownOption("yq", `--output-format=${format}`);
      }
      options.outputFormat = format;
    } else if (a.startsWith("--indent=")) {
      const indentValue = a.slice(9);
      const indent = parseIndent(indentValue);
      if (indent === null) return invalidIndent(indentValue);
      options.indent = indent;
    } else if (a.startsWith("--xml-attribute-prefix=")) {
      options.xmlAttributePrefix = a.slice(23);
    } else if (a.startsWith("--xml-content-name=")) {
      options.xmlContentName = a.slice(19);
    } else if (a.startsWith("--csv-delimiter=")) {
      options.csvDelimiter = a.slice(16);
    } else if (a === "--csv-header") {
      options.csvHeader = true;
    } else if (a === "--no-csv-header") {
      options.csvHeader = false;
    } else if (a === "-p" || a === "--input-format") {
      const format = formatName(args[++i]);
      if (!isValidInputFormat(format)) {
        return unknownOption("yq", `${a} ${format}`);
      }
      options.inputFormat = format;
      inputFormatExplicit = true;
    } else if (a === "-o" || a === "--output-format") {
      const format = formatName(args[++i]);
      outputFormatExplicit = true;
      if (!isValidOutputFormat(format)) {
        return unknownOption("yq", `${a} ${format}`);
      }
      options.outputFormat = format;
    } else if (a === "-I" || a === "--indent") {
      const indentValue = args[++i];
      const indent = parseIndent(indentValue);
      if (indent === null) return invalidIndent(indentValue);
      options.indent = indent;
    } else if (a === "-r" || a === "--raw-output") {
      options.raw = true;
    } else if (a === "-c" || a === "--compact") {
      options.compact = true;
    } else if (a === "-e" || a === "--exit-status") {
      options.exitStatus = true;
    } else if (a === "-s" || a === "--slurp") {
      options.slurp = true;
    } else if (a === "-n" || a === "--null-input") {
      options.nullInput = true;
    } else if (a === "-j" || a === "--tojson") {
      // mikefarah's -j is JSON output, not jq's join (1ctx)
      options.tojson = true;
    } else if (a === "-N" || a === "--no-doc") {
      options.noDoc = true;
    } else if (a === "--unwrapScalar" || a === "--unwrapScalar=true") {
      options.unwrapScalar = true;
    } else if (a === "--unwrapScalar=false") {
      options.unwrapScalar = false;
    } else if (a === "-i" || a === "--inplace") {
      options.inplace = true;
    } else if (a === "-f" || a === "--front-matter") {
      options.frontMatter = true;
    } else if (a === "-P" || a === "--prettyPrint") {
      options.prettyPrint = true;
    } else if (a === "-0" || a === "--nul-output") {
      options.nulOutput = true;
    } else if (
      a === "-M" ||
      a === "-C" ||
      a === "--no-colors" ||
      a === "--colors"
    ) {
      // colours are for a terminal, and the mount has none (1ctx)
    } else if (a === "-") {
      files.push("-");
      fileAt.push(i);
    } else if (a === "--version" || a === "-V") {
      // models check the version to pick mikefarah's syntax (1ctx)
      return {
        stdout:
          "yq (just-bash) version 4, the syntax of https://github.com/mikefarah/yq/\n",
        stderr: "",
        exitCode: 0,
      };
    } else if (a.startsWith("--")) {
      return unknownOption("yq", a);
    } else if (/^-[opI]=?./.test(a)) {
      // a value joined to its flag, as mikefarah's accepts: -ojson, -I0,
      // -o=json (1ctx)
      const joined = a.slice(a[2] === "=" ? 3 : 2);
      const value = a[1] === "I" ? joined : (formatName(joined) as string);
      if (a[1] === "I") {
        const indent = parseIndent(value);
        if (indent === null) return invalidIndent(value);
        options.indent = indent;
      } else if (a[1] === "o") {
        if (!isValidOutputFormat(value)) return unknownOption("yq", a);
        options.outputFormat = value;
        outputFormatExplicit = true;
      } else {
        if (!isValidInputFormat(value)) return unknownOption("yq", a);
        options.inputFormat = value;
        inputFormatExplicit = true;
      }
    } else if (a.startsWith("-")) {
      // Handle combined short options like -rc
      for (const c of a.slice(1)) {
        if (c === "r") options.raw = true;
        else if (c === "c") options.compact = true;
        else if (c === "e") options.exitStatus = true;
        else if (c === "s") options.slurp = true;
        else if (c === "n") options.nullInput = true;
        else if (c === "j") options.tojson = true;
        else if (c === "N") options.noDoc = true;
        else if (c === "i") options.inplace = true;
        else if (c === "f") options.frontMatter = true;
        else if (c === "P") options.prettyPrint = true;
        else if (c === "0") options.nulOutput = true;
        else if (c === "M" || c === "C") continue;
        else return unknownOption("yq", `-${c}`);
      }
    } else if (!filterSet && !command && (a === "eval" || a === "e")) {
      // mikefarah's `yq eval <filter> <file>` (1ctx)
      command = true;
    } else if (!filterSet && !command && (a === "eval-all" || a === "ea")) {
      // mikefarah's eval-all: every document of every file as one list
      // (1ctx)
      command = true;
      options.evalAll = true;
    } else if (!filterSet) {
      filter = a;
      filterSet = true;
    } else {
      files.push(a);
      fileAt.push(i);
    }
  }

  if (options.tojson) {
    options.outputFormat = "json";
    outputFormatExplicit = true;
  }

  return {
    options,
    filter,
    files,
    fileAt,
    inputFormatExplicit,
    outputFormatExplicit,
  };
}

export const yqCommand: RuntimeCommand = {
  name: "yq",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
    // the file's place among several, for the --- between files (1ctx)
    file = 0,
  ): Promise<ExecResult> {
    assertDefenseContext(ctx.requireDefenseContext, "yq", "execution entry");
    const withDefenseContext = <T>(
      phase: string,
      op: () => Promise<T>,
    ): Promise<T> =>
      awaitWithDefenseContext(ctx.requireDefenseContext, "yq", phase, op);

    if (hasHelpFlag(args)) return showHelp(yqHelp);

    const parsed = parseArgs(args);
    if ("exitCode" in parsed) return parsed;
    // mikefarah's words for -j, said once for every file (1ctx)
    const warning = parsed.options.tojson ? TOJSON_WARNING : "";

    const {
      options,
      filter,
      files,
      fileAt,
      inputFormatExplicit,
      outputFormatExplicit,
    } = parsed;

    if (options.evalAll) {
      return runEvalAll(parsed, ctx, withDefenseContext, warning);
    }

    // mikefarah's yq reads every file in turn; this one read the first and
    // dropped the rest without a word (1ctx)
    if (files.length > 1) {
      if (options.slurp || options.nullInput) {
        return {
          stdout: "",
          stderr: "yq: -s and -n read one file\n",
          exitCode: 1,
        };
      }
      if (options.inplace && files.includes("-")) {
        return {
          stdout: "",
          stderr: "yq: -i/--inplace requires a file argument\n",
          exitCode: 1,
        };
      }
      let stdout = "";
      let stderr = "";
      let misses = 0;
      const seen = new Set<string>();
      // the first file picks the output format for them all, as mikefarah's
      const first =
        !inputFormatExplicit &&
        !outputFormatExplicit &&
        detectFormatFromExtension(files[0]) === "json"
          ? "json"
          : options.outputFormat;
      // the key of the last result printed, as within one file
      let last: Key | null = null;
      for (const [file, at] of fileAt.entries()) {
        // a file named twice is edited once, as mikefarah reads them all
        // before writing
        if (options.inplace) {
          const path = ctx.fs.resolvePath(ctx.cwd, args[at]);
          if (seen.has(path)) continue;
          seen.add(path);
        }
        const one = args.filter((_, i) => !fileAt.includes(i) || i === at);
        if (!options.inplace && !outputFormatExplicit) one.unshift("-o", first);
        const result = await (yqCommand.execute as RunOne)(one, ctx, file);
        const [head, tail] = edges.get(result) ?? [null, null];
        const own = result.stderr.replaceAll(TOJSON_WARNING, "");
        stderr += own;
        // a file that matched nothing leaves it and the loop goes on; an
        // error says so on stderr and ends it
        const miss =
          result.exitCode === 1 &&
          (own === "" || own.includes("no matches found"));
        if (miss) misses++;
        if (result.stdout !== "") {
          const yaml =
            first === "yaml" && !options.noDoc && moved(last, head);
          stdout += (stdout !== "" && yaml ? "---\n" : "") + result.stdout;
          last = tail;
        }
        if (result.exitCode !== 0 && !miss) {
          return { stdout, stderr: warning + stderr, exitCode: result.exitCode };
        }
      }
      return {
        stdout,
        stderr: warning + stderr,
        exitCode: misses > 0 && misses === (options.inplace ? seen.size : fileAt.length) ? 1 : 0,
      };
    }

    // Auto-detect format from file extension if not explicitly set
    if (!inputFormatExplicit && files.length > 0 && files[0] !== "-") {
      const detected = detectFormatFromExtension(files[0]);
      if (detected) {
        options.inputFormat = detected;
      }
      // a .json file prints JSON unless -p or -o was given, as mikefarah's
      // (1ctx)
      if (detected === "json" && !outputFormatExplicit) {
        options.outputFormat = "json";
      }
    }
    // an in-place edit writes the file's own format back, as mikefarah's
    // does, not YAML into a .json file (1ctx)
    if (
      options.inplace &&
      !outputFormatExplicit &&
      isValidOutputFormat(options.inputFormat)
    ) {
      options.outputFormat = options.inputFormat;
    }

    // Inplace requires a file
    if (options.inplace && (files.length === 0 || files[0] === "-")) {
      return {
        stdout: "",
        stderr: "yq: -i/--inplace requires a file argument\n",
        exitCode: 1,
      };
    }

    // Read input. yq parses YAML/JSON/etc — stdin bytes from a piped command
    // arrive latin1-shaped, so decode to UTF-8 before handing to the parser.
    // File reads use default utf8 decoding already.
    let input: string;
    let filePath: string | undefined;
    if (options.nullInput) {
      input = "";
    } else if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
      input = decodeBytesToUtf8(ctx.stdin);
    } else {
      try {
        const resolvedFilePath = ctx.fs.resolvePath(ctx.cwd, files[0]);
        filePath = resolvedFilePath;
        input = await withDefenseContext("file read", () =>
          ctx.fs.readFile(resolvedFilePath),
        );
      } catch (e) {
        if (e instanceof SecurityViolationError) {
          throw e;
        }
        return {
          stdout: "",
          stderr: `yq: ${files[0]}: No such file or directory\n`,
          exitCode: 2,
        };
      }
    }

    // results are records, so an empty string is a result and the document
    // it came from travels with it (1ctx)
    const records: Result[] = [];
    // an error in a later document fails the run after the earlier
    // documents' results, as mikefarah's streams them (1ctx)
    let failure: unknown = null;
    try {
      const ast = parse(filter, {
        maxDepth: ctx.limits.maxQueryDepth,
        maxTokens: ctx.limits.maxQueryTokens,
        maxSourceLength: ctx.limits.maxStringLength,
      });
      const documents: YAML.Document[] = [];
      let documentValues: QueryValue[] = [];

      const evalOptions: EvaluateOptions = {
        limits: ctx.limits
          ? {
              maxIterations: ctx.limits.maxJqIterations,
              maxStringLength: ctx.limits.maxStringLength,
              maxOutputSize: ctx.limits.maxOutputSize,
              maxArrayElements: ctx.limits.maxQueryElements,
              maxDepth: ctx.limits.maxQueryDepth,
            }
          : undefined,
        env: ctx.env,
        coverage: ctx.coverage,
        requireDefenseContext: ctx.requireDefenseContext,
        budget: { operations: 0, callDepth: 0 },
        // mikefarah's rules where they part from jq's (1ctx)
        dialect: "yq",
      };
      const dataLimits = {
        maxDepth: ctx.limits.maxQueryDepth,
        maxElements: ctx.limits.maxQueryElements,
      };
      // load() reads its files before the run, which cannot wait (1ctx)
      const loads = await readLoads(ast, ctx, withDefenseContext);
      // mikefarah names stdin "-" when no file was given, and "" for -
      const filename = options.nullInput
        ? ""
        : files.length === 0
          ? "-"
          : files[0] === "-"
            ? ""
            : files[0];
      const run = (input: QueryValue, document: number): void => {
        for (const { value, state, index } of evaluateDocument(input, ast, {
          ...evalOptions,
          source: { document, file, filename, loads },
        })) {
          if (value !== undefined) {
            records.push({
              value,
              document,
              computed: state === "computed",
              index,
            });
          }
        }
      };

      if (options.nullInput) {
        run(null, 0);
      } else if (options.frontMatter) {
        // Extract and process front-matter only
        const fm = extractFrontMatter(input, dataLimits);
        if (!fm) {
          return {
            stdout: "",
            stderr: "yq: no front-matter found\n",
            exitCode: 1,
          };
        }
        run(fm.frontMatter, 0);
      } else if (options.slurp) {
        // Parse all documents into array
        let items: QueryValue[];
        if (options.inputFormat === "yaml") {
          // YAML supports multiple documents separated by ---
          items = parseAllYamlDocuments(input, dataLimits);
        } else {
          items = [parseInput(input, options, dataLimits)];
        }
        run(items, 0);
      } else {
        // mikefarah's yq runs the filter on each document of a YAML stream,
        // where this one refused a stream it was not told to slurp (1ctx)
        // -i reads every YAML file this way, to write its comments back
        if (
          options.inputFormat === "yaml" &&
          (options.inplace || /^---/m.test(input))
        ) {
          documentValues = parseAllYamlDocuments(input, dataLimits, documents);
        }
        if (
          documentValues.length > 1 ||
          (options.inplace && documentValues.length === 1)
        ) {
          for (const [index, document] of documentValues.entries()) {
            try {
              run(document, index);
            } catch (e) {
              if (options.inplace) throw e;
              failure = e;
              break;
            }
          }
        } else {
          run(parseInput(input, options, dataLimits), 0);
        }
      }

      if (
        options.inplace &&
        filePath &&
        options.outputFormat === "yaml" &&
        documents.length > 0
      ) {
        const maxBytes = Math.min(
          ctx.limits.maxStringLength,
          ctx.limits.maxOutputSize,
        );
        // nothing, or with -e only null and false: no write (1ctx)
        if (records.length === 0 || (options.exitStatus && missed(records))) {
          // mikefarah's answer, and no emptied file (1ctx)
          return {
            stdout: "",
            stderr: "yq: no matches found, the file is left as it was\n",
            exitCode: 1,
          };
        }
        const text = inPlaceText(records, documents, documentValues, {
          format: (value) =>
            formatOutput(value, { ...options, yaml11: true }, maxBytes),
          maxDepth: ctx.limits.maxQueryDepth,
          // `... comments=""` writes the documents afresh, without them
          plain: hasNode(ast, stripsComments),
        });
        if (text === null) {
          return {
            stdout: "",
            stderr:
              "yq: the file is left as it was: this edit rewrites the whole document, which would change values a YAML 1.1 reader reads (like 0644 or yes); edit without reordering keys or going through an alias\n",
            exitCode: 1,
          };
        }
        if (text.length > maxBytes) {
          throw new ExecutionLimitError(
            `output size limit exceeded (${maxBytes} bytes)`,
            "output_size",
          );
        }
        await withDefenseContext("in-place write", () =>
          ctx.fs.writeFile(filePath, text),
        );
        return {
          stdout: "",
          stderr: warning,
          exitCode: options.exitStatus && missed(records) ? 1 : 0,
        };
      }

      const finalOutput = printRecords(records, options, ctx, file);

      // Handle inplace mode
      if (options.inplace && filePath) {
        // nothing, or with -e only null and false: no write (1ctx)
        if (records.length === 0 || (options.exitStatus && missed(records))) {
          return {
            stdout: "",
            stderr: "yq: no matches found, the file is left as it was\n",
            exitCode: 1,
          };
        }
        await withDefenseContext("in-place write", () =>
          ctx.fs.writeFile(filePath, finalOutput),
        );
        return {
          stdout: "",
          stderr: warning,
          exitCode: options.exitStatus && missed(records) ? 1 : 0,
        };
      }

      const result =
        failure !== null
          ? { ...failed(failure), stdout: finalOutput }
          : {
              stdout: finalOutput,
              stderr: warning,
              exitCode: options.exitStatus && missed(records) ? 1 : 0,
            };
      if (records.length > 0) {
        edges.set(result, [
          keyOf(records[0], file),
          keyOf(records[records.length - 1], file),
        ]);
      }
      return result;
    } catch (e) {
      return failed(e);
    }
  },
};

/** Whether a node of the filter satisfies `test`. (1ctx) */
function hasNode(ast: AstNode, test: (node: AstNode) => boolean): boolean {
  const visit = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (node === null || typeof node !== "object") return false;
    if (test(node as AstNode)) return true;
    return Object.values(node).some(visit);
  };
  return visit(ast);
}

/**
 * The files the filter's load() and load_str() name, read through the
 * mount from the working directory under its string limit. (1ctx)
 */
async function readLoads(
  ast: AstNode,
  ctx: RuntimeCommandContext,
  withDefenseContext: <T>(phase: string, op: () => Promise<T>) => Promise<T>,
): Promise<QuerySource["loads"]> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const call = node as AstNode;
    if (
      call.type === "Call" &&
      (call.name === "load" || call.name === "load_str") &&
      call.args.length === 1 &&
      call.args[0].type === "Literal" &&
      typeof call.args[0].value === "string"
    ) {
      names.add(call.args[0].value);
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(ast);
  const loads: QuerySource["loads"] = new Map();
  for (const name of names) {
    try {
      const text = await withDefenseContext("load read", () =>
        ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, name)),
      );
      loads.set(
        name,
        text.length > ctx.limits.maxStringLength
          ? { error: `failed to load ${name}: larger than the string limit` }
          : { text },
      );
    } catch (e) {
      if (e instanceof SecurityViolationError) throw e;
      loads.set(name, {
        error: `failed to load ${name}: no such file or directory`,
      });
    }
  }
  return loads;
}

/**
 * mikefarah's eval-all: every document of every file read first, the
 * filter run once over the list, and -i writing each file its own
 * documents' results. (1ctx)
 */
async function runEvalAll(
  parsed: ParsedArgs,
  ctx: RuntimeCommandContext,
  withDefenseContext: <T>(phase: string, op: () => Promise<T>) => Promise<T>,
  warning: string,
): Promise<ExecResult> {
  const { options, filter, files, inputFormatExplicit, outputFormatExplicit } =
    parsed;
  if (options.slurp || options.frontMatter) {
    return {
      stdout: "",
      stderr: "yq: eval-all reads every document itself, without -s or -f\n",
      exitCode: 1,
    };
  }
  if (options.inplace && (files.length === 0 || files.includes("-"))) {
    return {
      stdout: "",
      stderr: "yq: -i/--inplace requires a file argument\n",
      exitCode: 1,
    };
  }
  const first = files.find((name) => name !== "-");
  if (
    first !== undefined &&
    !inputFormatExplicit &&
    !outputFormatExplicit &&
    detectFormatFromExtension(first) === "json"
  ) {
    options.outputFormat = "json";
  }
  const dataLimits = {
    maxDepth: ctx.limits.maxQueryDepth,
    maxElements: ctx.limits.maxQueryElements,
  };
  const inputs: Input[] = [];
  // per file, for -i: its path, format, parsed documents and their values
  const read: {
    path: string;
    format: InputFormatName;
    documents: YAML.Document[];
    values: QueryValue[];
  }[] = [];
  try {
    const names = options.nullInput ? [] : files.length === 0 ? ["-"] : files;
    if (options.nullInput) {
      inputs.push({ value: null, document: 0, file: 0, filename: "" });
    }
    for (const [file, name] of names.entries()) {
      let text: string;
      let path = "";
      if (name === "-") {
        text = decodeBytesToUtf8(ctx.stdin);
      } else {
        path = ctx.fs.resolvePath(ctx.cwd, name);
        try {
          text = await withDefenseContext("file read", () =>
            ctx.fs.readFile(path),
          );
        } catch (e) {
          if (e instanceof SecurityViolationError) throw e;
          return {
            stdout: "",
            stderr: `yq: ${name}: No such file or directory\n`,
            exitCode: 2,
          };
        }
      }
      const format =
        inputFormatExplicit || name === "-"
          ? options.inputFormat
          : (detectFormatFromExtension(name) ?? options.inputFormat);
      const documents: YAML.Document[] = [];
      const values =
        format === "yaml"
          ? parseAllYamlDocuments(text, dataLimits, documents)
          : [parseInput(text, { ...options, inputFormat: format }, dataLimits)];
      read.push({ path, format, documents, values });
      const filename = files.length === 0 ? "-" : name === "-" ? "" : name;
      for (const [document, value] of values.entries()) {
        inputs.push({ value, document, file, filename });
      }
    }

    const ast = parse(filter, {
      maxDepth: ctx.limits.maxQueryDepth,
      maxTokens: ctx.limits.maxQueryTokens,
      maxSourceLength: ctx.limits.maxStringLength,
    });
    const loads = await readLoads(ast, ctx, withDefenseContext);
    const evalOptions: EvaluateOptions = {
      limits: {
        maxIterations: ctx.limits.maxJqIterations,
        maxStringLength: ctx.limits.maxStringLength,
        maxOutputSize: ctx.limits.maxOutputSize,
        maxArrayElements: ctx.limits.maxQueryElements,
        maxDepth: ctx.limits.maxQueryDepth,
      },
      env: ctx.env,
      coverage: ctx.coverage,
      requireDefenseContext: ctx.requireDefenseContext,
      budget: { operations: 0, callDepth: 0 },
      dialect: "yq",
    };
    const records: Result[] = [];
    for (const result of evaluateAll(inputs, ast, evalOptions, loads)) {
      if (result.value === undefined) continue;
      records.push({
        value: result.value,
        document: result.input.document,
        computed: result.state === "computed",
        index: result.index,
        file: result.input.file,
      });
    }

    if (!options.inplace) {
      return {
        stdout: printRecords(records, options, ctx, 0),
        stderr: warning,
        exitCode: options.exitStatus && missed(records) ? 1 : 0,
      };
    }

    if (records.length === 0 || (options.exitStatus && missed(records))) {
      return {
        stdout: "",
        stderr: "yq: no matches found, the file is left as it was\n",
        exitCode: 1,
      };
    }
    const maxBytes = Math.min(
      ctx.limits.maxStringLength,
      ctx.limits.maxOutputSize,
    );
    for (const [file, source] of read.entries()) {
      const own = records.filter((record) => record.file === file);
      if (own.length === 0) continue;
      const written = outputFormatExplicit
        ? options.outputFormat
        : isValidOutputFormat(source.format)
          ? source.format
          : options.outputFormat;
      const text =
        written === "yaml" && source.format === "yaml"
          ? inPlaceText(own, source.documents, source.values, {
              format: (value) =>
                formatOutput(value, { ...options, yaml11: true }, maxBytes),
              maxDepth: ctx.limits.maxQueryDepth,
              plain: hasNode(ast, stripsComments),
            })
          : printRecords(own, { ...options, outputFormat: written }, ctx, 0);
      if (text === null) {
        return {
          stdout: "",
          stderr:
            "yq: the file is left as it was: this edit rewrites the whole document, which would change values a YAML 1.1 reader reads (like 0644 or yes); edit without reordering keys or going through an alias\n",
          exitCode: 1,
        };
      }
      if (text.length > maxBytes) {
        throw new ExecutionLimitError(
          `output size limit exceeded (${maxBytes} bytes)`,
          "output_size",
        );
      }
      await withDefenseContext("in-place write", () =>
        ctx.fs.writeFile(source.path, text),
      );
    }
    return {
      stdout: "",
      stderr: warning,
      exitCode: options.exitStatus && missed(records) ? 1 : 0,
    };
  } catch (e) {
    return failed(e);
  }
}

/** The answer for an error the run stopped on. */
function failed(e: unknown): ExecResult {
  if (e instanceof SecurityViolationError) {
    throw e;
  }
  if (e instanceof ExecutionLimitError) {
    const message = sanitizeErrorMessage(e.message);
    return {
      stdout: "",
      stderr: `yq: ${message}\n`,
      exitCode: ExecutionLimitError.EXIT_CODE,
    };
  }
  const msg = sanitizeErrorMessage((e as Error).message);
  if (msg.includes("Unknown function")) {
    return {
      stdout: "",
      stderr: `yq: error: ${msg}\n`,
      exitCode: 3,
    };
  }
  return {
    stdout: "",
    stderr: `yq: parse error: ${msg}\n`,
    exitCode: 5,
  };
}

/**
 * A result, the document its input was, and whether a function computed
 * it, which makes it count as read from document 0. (1ctx)
 */
interface Result {
  value: QueryValue;
  document: number;
  computed: boolean;
  /** the document splitDoc gave it */
  index?: number;
  /** the file it was read from, in an eval-all run */
  file?: number;
}

/** The file and the document a result counts as read from. (1ctx) */
type Key = [file: number, document: number];

// both 0 for a computed value
function keyOf(record: Result, file: number): Key {
  const at = record.file ?? file;
  if (record.index !== undefined) return [at, record.index];
  return record.computed ? [0, 0] : [at, record.document];
}

// mikefarah prints --- where the document index changes, or a later file
// starts; a computed value after a later file prints none (probed)
function moved(last: Key | null, next: Key | null): boolean {
  if (last === null || next === null) return false;
  return last[1] !== next[1] || next[0] > last[0];
}

/**
 * The text of the results: one per line, or each ended by a NUL with -0,
 * --- where the document moves in YAML output unless -N, a top-level
 * string raw. (1ctx)
 */
function printRecords(
  records: Result[],
  options: YqOptions,
  ctx: RuntimeCommandContext,
  file: number,
): string {
  const maxOutputSize = Math.min(
    ctx.limits.maxStringLength,
    ctx.limits.maxOutputSize,
  );
  const output = new BoundedStringBuilder(
    maxOutputSize,
    "yq output",
    () =>
      new ExecutionLimitError(
        `output size limit exceeded (${maxOutputSize} bytes)`,
        "output_size",
      ),
  );
  let lastKey: Key | null = null;
  const marker = options.outputFormat === "yaml" && !options.noDoc;
  const end = options.nulOutput ? "\0" : "\n";
  for (const record of records) {
    const { value } = record;
    const key = keyOf(record, file);
    if (
      getValueDepth(value, ctx.limits.maxQueryDepth + 1) >
      ctx.limits.maxQueryDepth
    ) {
      throw new ExecutionLimitError(
        `query depth limit exceeded (${ctx.limits.maxQueryDepth})`,
        "recursion",
      );
    }
    const between = marker && moved(lastKey, key) ? "---\n" : "";
    const remainingBytes = output.remainingBytes - between.length - 1;
    if (remainingBytes < 0) {
      throw new ExecutionLimitError(
        `output size limit exceeded (${maxOutputSize} bytes)`,
        "output_size",
      );
    }
    const serializationLimit = Math.min(
      remainingBytes,
      ctx.executionScope?.remainingLiveBytes ?? remainingBytes,
    );
    const serializationLease = ctx.executionScope?.reserveBytes(
      "yq serialization",
      serializationLimit,
      "yq output",
    );
    let text: string;
    try {
      text = formatOutput(value, options, serializationLimit);
    } finally {
      serializationLease?.release();
    }
    // a format with nothing to say for a value (ini of a list) prints no
    // line; an empty string is one
    if (text === "" && typeof value !== "string") {
      continue;
    }
    if (options.nulOutput && text.includes("\0")) {
      throw new Error("a result holds a NUL, which -0 cannot print");
    }
    output.append(between);
    output.append(text);
    output.append(end);
    lastKey = key;
  }
  return output.build();
}

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "yq",
  flags: [
    { flag: "-r", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-i", type: "value", valueHint: "string" },
    { flag: "-o", type: "value", valueHint: "string" },
  ],
  stdinType: "text",
  needsArgs: true,
};

/**
 * The file an in-place edit writes: each document's results, a single
 * container result applied onto the parsed document so its comments stay,
 * --- between documents as they print, none before the first, a document
 * dropped when its filter output nothing. (1ctx)
 */
function inPlaceText(
  records: Result[],
  documents: YAML.Document[],
  documentValues: QueryValue[],
  opts: {
    format: (value: QueryValue) => string;
    maxDepth: number;
    /** written from the values, so the file's comments go */
    plain?: boolean;
  },
): string | null {
  const groups: Result[][] = documents.map(() => []);
  for (const record of records) {
    const { value, document } = record;
    if (getValueDepth(value, opts.maxDepth + 1) > opts.maxDepth) {
      throw new ExecutionLimitError(
        `query depth limit exceeded (${opts.maxDepth})`,
        "recursion",
      );
    }
    groups[document].push(record);
  }
  let text = "";
  let lastKey: Key | null = null;
  for (const [index, group] of groups.entries()) {
    if (group.length === 0) continue;
    // several results for one document: mikefarah writes the last
    const record = group[group.length - 1];
    const last = record.value;
    let part = opts.plain
      ? null
      : preservingText(documents[index], documentValues[index], last);
    if (part === null) {
      // written afresh from values: refused when that would change what a
      // YAML 1.1 reader gets from an untouched scalar (0644, yes), or
      // expand an alias
      if (spelledFor11(documents[index])) return null;
      if (opts.plain && hasAlias(documents[index])) return null;
      part = opts.format(last);
    }
    // the markers are written here, where the document moves
    const key = keyOf(record, 0);
    if (lastKey !== null) text += moved(lastKey, key) ? "\n---\n" : "\n";
    text += part.replace(/^---\n/, "");
    lastKey = key;
  }
  return `${text}\n`;
}

/** -e: nothing came out, or only null and false. */
function missed(records: Result[]): boolean {
  return (
    records.length === 0 ||
    records.every(({ value: v }) => v === null || v === false)
  );
}
