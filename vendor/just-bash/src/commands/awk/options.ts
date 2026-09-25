/**
 * (1ctx) AWK command line: options, operand assignments and their names.
 *
 * gawk keeps -v and -F in the order given and replays them before BEGIN,
 * reads -f program files, and treats a `name=value` operand as an
 * assignment done when the input walk reaches it.
 */

import { awkBuiltins } from "./builtins.js";
import { isGawkBuiltin, isUnsupportedName } from "./check.js";
import { KEYWORDS } from "./lexer.js";

export interface AwkAssignment {
  name: string;
  value: string;
}

export interface AwkOptions {
  /** -v and -F in the order given, -F as an FS assignment. */
  assignments: AwkAssignment[];
  /** -f program files in order; empty when the program is an operand. */
  programFiles: string[];
  /** The program text, when no -f was given. */
  program?: string;
  operands: string[];
}

export type ParsedOptions =
  | { ok: true; options: AwkOptions }
  | { ok: false; stderr: string; exitCode: number }
  // --version or -V among the options
  | { ok: false; version: true };

const AWK_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPERAND_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Names gawk refuses as a variable: its keywords and builtin functions. */
export function isReservedName(name: string): boolean {
  return (
    KEYWORDS.has(name) ||
    awkBuiltins.has(name) ||
    isGawkBuiltin(name) ||
    name === "func" ||
    name === "BEGINFILE" ||
    name === "ENDFILE"
  );
}

export function parseOptions(args: string[]): ParsedOptions {
  const assignments: AwkAssignment[] = [];
  const programFiles: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) break;
    if (arg === "--version" || arg === "-V") return { ok: false, version: true };
    if (arg.startsWith("--")) {
      return fail(`awk: unrecognized option '${arg}'\n`);
    }
    const opt = arg[1];
    if (opt !== "F" && opt !== "v" && opt !== "f") {
      return fail(`awk: invalid option -- '${opt}'\n`);
    }
    let value = arg.slice(2);
    if (value === "") {
      if (i + 1 >= args.length) {
        return fail(`awk: option requires an argument -- '${opt}'\n`);
      }
      value = args[++i];
    }
    if (opt === "F") {
      assignments.push({ name: "FS", value: awkEscapes(value) });
    } else if (opt === "f") {
      programFiles.push(value);
    } else {
      const eq = value.indexOf("=");
      if (eq < 0) {
        return fail(
          `awk: '${value}' argument to '-v' not in 'var=value' form\n`,
        );
      }
      const name = value.slice(0, eq);
      if (!AWK_NAME.test(name)) {
        return fail(`awk: '${name}' is not a legal variable name\n`, 2);
      }
      if (isReservedName(name)) {
        return fail(`awk: cannot use gawk builtin '${name}' as variable name\n`, 2);
      }
      if (isUnsupportedName(name)) {
        return fail(`awk: ${name} is not supported\n`, 2);
      }
      assignments.push({ name, value: awkEscapes(value.slice(eq + 1)) });
    }
  }

  if (programFiles.length > 0) {
    return {
      ok: true,
      options: { assignments, programFiles, operands: args.slice(i) },
    };
  }
  if (i >= args.length) return fail("awk: missing program\n");
  return {
    ok: true,
    options: {
      assignments,
      programFiles,
      program: args[i],
      operands: args.slice(i + 1),
    },
  };
}

/** An operand of the form `name=value` with an awk name, else null. */
export function operandAssignment(arg: string): AwkAssignment | null {
  const m = OPERAND_ASSIGNMENT.exec(arg);
  if (!m) return null;
  return { name: m[1], value: awkEscapes(arg.slice(m[0].length)) };
}

/** awk's string escapes, as a string literal reads them. */
export function awkEscapes(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\\" || i + 1 >= text.length) {
      out += ch;
      continue;
    }
    const next = text[++i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "f":
        out += "\f";
        break;
      case "b":
        out += "\b";
        break;
      case "v":
        out += "\v";
        break;
      case "a":
        out += "\x07";
        break;
      case "x": {
        let hex = "";
        while (hex.length < 2 && /[0-9a-fA-F]/.test(text[i + 1] ?? "")) {
          hex += text[++i];
        }
        out += hex ? String.fromCharCode(parseInt(hex, 16)) : "x";
        break;
      }
      default:
        if (/[0-7]/.test(next)) {
          let octal = next;
          while (octal.length < 3 && /[0-7]/.test(text[i + 1] ?? "")) {
            octal += text[++i];
          }
          out += String.fromCharCode(parseInt(octal, 8));
        } else {
          out += next;
        }
    }
  }
  return out;
}

function fail(stderr: string, exitCode = 1): ParsedOptions {
  return { ok: false, stderr, exitCode };
}
