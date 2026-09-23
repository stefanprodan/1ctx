/**
 * (1ctx) Checks gawk makes before a program runs.
 *
 * gawk refuses a builtin called with the wrong number of arguments, and a
 * function named after a builtin, before BEGIN, wherever the call stands.
 * We also refuse the gawk extensions we do not have rather than ignore
 * them: their names would otherwise be ordinary variables.
 */

import type { AwkProgram } from "./ast.js";

/** A program refused before it runs, with the exit code gawk uses. */
export class AwkRefusal extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/** gawk 5.4.1's argument counts for the builtins we register. */
const ARGUMENT_COUNTS: ReadonlyMap<string, readonly [number, number]> =
  new Map([
    ["length", [0, 1]],
    ["substr", [2, 3]],
    ["index", [2, 2]],
    ["split", [2, 4]],
    ["sub", [2, 3]],
    ["gsub", [2, 3]],
    ["match", [2, 3]],
    ["gensub", [3, 4]],
    ["tolower", [1, 1]],
    ["toupper", [1, 1]],
    // sprintf() with none passes the parse and fails when it runs
    ["sprintf", [0, Number.POSITIVE_INFINITY]],
    ["int", [1, 1]],
    ["sqrt", [1, 1]],
    ["sin", [1, 1]],
    ["cos", [1, 1]],
    ["atan2", [2, 2]],
    ["log", [1, 1]],
    ["exp", [1, 1]],
    ["rand", [0, 0]],
    ["srand", [0, 1]],
    ["system", [1, 1]],
    ["close", [1, 2]],
    ["fflush", [0, 1]],
    ["systime", [0, 0]],
    ["mktime", [1, 2]],
    ["strftime", [0, 3]],
  ]);

const CHANGEABLE = new Set([
  "variable",
  "field",
  "array_access",
  "string",
  "number",
]);

/** The builtins a program may call, and so may not define. */
export function isBuiltinFunction(name: string): boolean {
  return ARGUMENT_COUNTS.has(name);
}

/** gawk names we do not honour; a program that uses one is refused. */
const UNSUPPORTED = new Set([
  "BEGINFILE",
  "ENDFILE",
  "PROCINFO",
  "IGNORECASE",
  "FPAT",
  "FIELDWIDTHS",
]);

export function isUnsupportedName(name: string): boolean {
  return UNSUPPORTED.has(name);
}

export function unsupported(name: string): AwkRefusal {
  return new AwkRefusal(`${name} is not supported`, 2);
}

export function checkProgram(program: AwkProgram): void {
  for (const fn of program.functions) {
    if (isBuiltinFunction(fn.name)) {
      throw new AwkRefusal(
        `'${fn.name}' is a built-in function, it cannot be redefined`,
        1,
      );
    }
  }
  walk(program, (node) => {
    switch (node.type) {
      case "call": {
        const bounds = ARGUMENT_COUNTS.get(node.name as string);
        const count = (node.args as unknown[]).length;
        if (bounds && (count < bounds[0] || count > bounds[1])) {
          throw new AwkRefusal(
            `${count} is invalid as number of arguments for ${node.name}`,
            1,
          );
        }
        // gawk takes a variable, a field, an element or a constant here
        if (
          (node.name === "sub" || node.name === "gsub") &&
          count === 3 &&
          !CHANGEABLE.has((node.args as Node[])[2].type)
        ) {
          throw new AwkRefusal(
            `${node.name} third parameter is not a changeable object`,
            1,
          );
        }
        break;
      }
      case "variable":
      case "for_in":
      case "getline":
        refuse(node.name ?? node.variable);
        refuse(node.array);
        break;
      case "array_access":
      case "in":
        refuse(node.array);
        break;
    }
  });
}

function refuse(name: unknown): void {
  if (typeof name === "string" && UNSUPPORTED.has(name)) {
    throw unsupported(name);
  }
}

type Node = { type: string; [key: string]: unknown };

function walk(value: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Node;
  if (typeof node.type === "string") visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}
