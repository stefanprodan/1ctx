import { latin1FromBytes } from "../../encoding.js";
import { mapToRecord } from "../../helpers/env.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";

const envHelp = {
  name: "env",
  summary: "run a program in a modified environment",
  usage: "env [OPTION]... [NAME=VALUE]... [COMMAND [ARG]...]",
  options: [
    "-i, --ignore-environment  start with an empty environment",
    "-u NAME, --unset=NAME     remove NAME from the environment",
    "    --help                display this help and exit",
  ],
};

// (1ctx env-options) env's own failures exit 125, as GNU's do
function envFailure(stderr: string): ExecResult {
  return { stdout: "", stderr, exitCode: 125 };
}

// (1ctx exec-env) a process sees the exported variables, never the shell's own
function exportedEnv(ctx: RuntimeCommandContext): Record<string, string> {
  return ctx.exportedEnv ?? mapToRecord(ctx.env);
}

export const envCommand: RuntimeCommand = {
  name: "env",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(envHelp);
    }

    // (1ctx env-options) GNU's parse: options up to the first operand or `--`, `-` is
    // -i, a cluster may end in -u's value, then NAME=VALUE, then the command
    let ignoreEnv = false;
    const unsetVars: string[] = [];
    const setVars = new Map<string, string>();
    let i = 0;
    for (; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        i++;
        break;
      }
      if (arg === "-" || arg === "-i" || arg === "--ignore-environment") {
        ignoreEnv = true;
        continue;
      }
      if (arg === "--unset" || arg.startsWith("--unset=")) {
        const name = arg === "--unset" ? args[++i] : arg.slice(8);
        if (name === undefined) {
          return envFailure("env: option '--unset' requires an argument\n");
        }
        unsetVars.push(name);
        continue;
      }
      if (arg.startsWith("--")) {
        return envFailure(unknownOption("env", arg).stderr);
      }
      if (!arg.startsWith("-")) break;
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j];
        if (c === "i") {
          ignoreEnv = true;
        } else if (c === "u") {
          const name = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
          if (name === undefined) {
            return envFailure("env: option requires an argument -- 'u'\n");
          }
          unsetVars.push(name);
          break;
        } else {
          return envFailure(unknownOption("env", `-${c}`).stderr);
        }
      }
    }
    for (; i < args.length && args[i].includes("="); i++) {
      const eqIdx = args[i].indexOf("=");
      setVars.set(args[i].slice(0, eqIdx), args[i].slice(eqIdx + 1));
    }
    const commandStart = i < args.length ? i : -1;
    // (1ctx env-options) glibc's unsetenv refuses an empty name or one with `=`
    for (const name of unsetVars) {
      if (name === "" || name.includes("=")) {
        return envFailure(`env: cannot unset '${name}': Invalid argument\n`);
      }
    }

    // Build the new environment
    let newEnv: Map<string, string>;
    if (ignoreEnv) {
      newEnv = new Map(setVars);
    } else {
      // (1ctx exec-env) from the exported variables, as a process's environment is
      newEnv = new Map(Object.entries(exportedEnv(ctx)));
      // Unset variables
      for (const name of unsetVars) {
        newEnv.delete(name);
      }
      // Set new variables
      for (const [name, value] of setVars) {
        newEnv.set(name, value);
      }
    }

    // If no command, just print environment
    if (commandStart === -1) {
      const lines: string[] = [];
      for (const [key, value] of newEnv) {
        lines.push(`${key}=${value}`);
      }
      return {
        stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0,
      };
    }

    // Execute command with modified environment
    if (!ctx.exec) {
      return {
        stdout: "",
        stderr: "env: command execution not supported in this context\n",
        exitCode: 1,
      };
    }

    // Build command line
    // Use 'command' prefix to bypass shell keywords (like 'time')
    // This ensures we run the actual command, not the shell keyword
    const cmdArgs = args.slice(commandStart);

    // Execute with explicitly provided environment so untrusted values never
    // get reparsed as shell source via assignment prefixes.
    // (1ctx env-options) `--` so a command named like an option is not read as one
    return ctx.exec("command --", {
      cwd: ctx.cwd,
      env: mapToRecord(newEnv),
      replaceEnv: true,
      stdin: latin1FromBytes(ctx.stdin),
      // ctx.stdin is already byte-shaped — forward verbatim.
      stdinKind: "bytes",
      signal: ctx.signal,
      args: cmdArgs,
    });
  },
};

const printenvHelp = {
  name: "printenv",
  summary: "print all or part of environment",
  usage: "printenv [OPTION]... [VARIABLE]...",
  options: ["    --help       display this help and exit"],
};

export const printenvCommand: RuntimeCommand = {
  name: "printenv",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(printenvHelp);
    }

    const vars = args.filter((arg) => !arg.startsWith("-"));
    // (1ctx exec-env) the exported variables, as GNU printenv sees them
    const env = new Map(Object.entries(exportedEnv(ctx)));

    if (vars.length === 0) {
      // Print all
      const lines: string[] = [];
      for (const [key, value] of env) {
        lines.push(`${key}=${value}`);
      }
      return {
        stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
        stderr: "",
        exitCode: 0,
      };
    }

    // Print specific variables
    const lines: string[] = [];
    let exitCode = 0;
    for (const varName of vars) {
      const value = env.get(varName);
      if (value !== undefined) {
        lines.push(value);
      } else {
        exitCode = 1;
      }
    }

    return {
      stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
      stderr: "",
      exitCode,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "env",
  flags: [
    { flag: "-i", type: "boolean" },
    { flag: "-u", type: "value", valueHint: "string" },
  ],
};

export const printenvFlagsForFuzzing: CommandFuzzInfo = {
  name: "printenv",
  flags: [],
};
