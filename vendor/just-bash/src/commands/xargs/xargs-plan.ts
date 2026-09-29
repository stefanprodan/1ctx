/**
 * (1ctx) The command lines xargs runs, built as GNU xargs 4.11 builds
 * them: items fill a line up to -s bytes, each argument counted with its
 * terminating NUL, then the next line starts; -n and -L cap a line
 * further and make an overflow an error; -I runs one line per input
 * line; with no item at all the command runs once, unless -r.
 */

import { ExecutionLimitError } from "../../interpreter/errors.js";
import { utf8ByteLength } from "../printf/escapes.js";

export interface PlanOptions {
  command: string[];
  replace: string | null;
  maxLines: number | null;
  maxArgs: number | null;
  /** the command-line budget in bytes */
  maxChars: number;
  exit: boolean;
  noRunIfEmpty: boolean;
  /** the input ended on an error: no run-once */
  inputFailed: boolean;
  maxStringLength: number;
}

export interface Plan {
  commands: string[][];
  /** GNU's words for the line that could not be built, after the rest */
  error: string | null;
}

function argSize(arg: string): number {
  return utf8ByteLength(arg) + 1;
}

function replaceAll(
  template: string,
  replace: string,
  item: string,
  maxStringLength: number,
): string {
  if (replace === "") return template;
  const parts = template.split(replace);
  const bytes =
    utf8ByteLength(template) +
    (parts.length - 1) * (utf8ByteLength(item) - utf8ByteLength(replace));
  if (bytes > maxStringLength) {
    throw new ExecutionLimitError(
      `xargs: string length limit exceeded (${maxStringLength} bytes)`,
      "string_length",
    );
  }
  return parts.join(item);
}

export function planCommands(lines: string[][], o: PlanOptions): Plan {
  const commands: string[][] = [];
  const base = o.command.reduce((sum, arg) => sum + argSize(arg), 0);

  if (o.replace !== null) {
    const replace = o.replace;
    for (const [item] of lines) {
      if (base > o.maxChars) return { commands, error: "command too long" };
      if (argSize(item) > o.maxChars) {
        return { commands, error: "argument line too long" };
      }
      // the command name is never replaced, only the initial arguments
      const line = [
        o.command[0],
        ...o.command
          .slice(1)
          .map((arg) => replaceAll(arg, replace, item, o.maxStringLength)),
      ];
      if (line.reduce((sum, arg) => sum + argSize(arg), 0) > o.maxChars) {
        return { commands, error: "argument list too long" };
      }
      commands.push(line);
    }
    return { commands, error: null };
  }

  if (base > o.maxChars) {
    return {
      commands,
      error: "cannot fit single argument within argument list size limit",
    };
  }
  // -L implies -x, and -x only matters beside a count
  const strict = o.maxLines !== null || (o.exit && o.maxArgs !== null);
  let current: string[] = [];
  let size = base;
  let lineCount = 0;
  let items = 0;
  const flush = () => {
    commands.push([...o.command, ...current]);
    current = [];
    size = base;
    lineCount = 0;
  };
  for (const line of lines) {
    for (const item of line) {
      items++;
      const itemSize = argSize(item);
      if (size + itemSize > o.maxChars) {
        if (current.length > 0 && strict) {
          return { commands, error: "argument list too long" };
        }
        if (current.length > 0) flush();
        if (size + itemSize > o.maxChars) {
          return { commands, error: "argument line too long" };
        }
      }
      current.push(item);
      size += itemSize;
      if (o.maxArgs !== null && current.length >= o.maxArgs) flush();
    }
    if (o.maxLines !== null && current.length > 0) {
      lineCount++;
      if (lineCount >= o.maxLines) flush();
    }
  }
  if (current.length > 0) flush();
  if (items === 0 && !o.noRunIfEmpty && !o.inputFailed) {
    commands.push([...o.command]);
  }
  return { commands, error: null };
}
