// (1ctx readonly-errors)
import { readErrorWords } from "../../fs/error-words.js";
import { decodeBytesToUtf8, latin1FromBytes } from "../../encoding.js";
import { mergeToNullPrototype } from "../../helpers/env.js";
import type { ShellOptions } from "../../interpreter/types.js"; // (1ctx shell-options)
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { showHelp } from "../help.js"; // (1ctx shell-options)

const bashHelp = {
  name: "bash",
  summary: "execute shell commands or scripts",
  usage: "bash [OPTIONS] [SCRIPT_FILE] [ARGUMENTS...]",
  // (1ctx shell-options)
  options: [
    "-c            read commands from the first argument",
    "-e -u -x -v   errexit, nounset, xtrace, verbose, as set does",
    "-n -f -a -C   noexec, noglob, allexport, noclobber, as set does",
    "-o NAME       set -o NAME; a + form, as +e or +o NAME, unsets",
    "--            end the options",
    "--noprofile   accepted, does nothing",
    "--norc        accepted, does nothing",
    "--help        display this help and exit",
  ],
  notes: [
    "Without -c, reads and executes commands from SCRIPT_FILE, or stdin.",
    "Arguments are passed as $1, $2, etc. to the script.",
    '$0 is set to the script name (or "bash" with -c).',
  ],
};

export const bashCommand: RuntimeCommand = {
  name: "bash",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    return runShell("bash", bashHelp, args, ctx); // (1ctx shell-options)
  },
};

// sh is an alias for bash
export const shCommand: RuntimeCommand = {
  name: "sh",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    // (1ctx shell-options)
    return runShell(
      "sh",
      {
        ...bashHelp,
        name: "sh",
        usage: bashHelp.usage.replace("bash", "sh"),
        summary: "execute shell commands or scripts (POSIX shell)",
      },
      args,
      ctx,
    );
  },
};

// (1ctx shell-options) the set letters and -o names a new shell takes, as
// set takes them; null is accepted and does nothing
const SHORT_OPTIONS = new Map<string, keyof ShellOptions | null>([
  ["e", "errexit"],
  ["u", "nounset"],
  ["x", "xtrace"],
  ["v", "verbose"],
  ["f", "noglob"],
  ["C", "noclobber"],
  ["a", "allexport"],
  ["n", "noexec"],
  ..."hbmBHPTEp".split("").map((c) => [c, null] as [string, null]),
]);
const LONG_OPTIONS = new Map<string, keyof ShellOptions | null>([
  ...(
    [
      "errexit",
      "pipefail",
      "nounset",
      "xtrace",
      "verbose",
      "noclobber",
      "noglob",
      "allexport",
      "noexec",
      "posix",
      "vi",
      "emacs",
    ] as const
  ).map((k) => [k, k] as [string, keyof ShellOptions]),
  ...[
    "notify",
    "monitor",
    "braceexpand",
    "histexpand",
    "physical",
    "functrace",
    "errtrace",
    "privileged",
    "hashall",
    "ignoreeof",
    "interactive-comments",
    "keyword",
    "onecmd",
  ].map((k) => [k, null] as [string, null]),
]);

type Invocation =
  | { kind: "error"; result: ExecResult }
  | { kind: "help" }
  | {
      kind: "run";
      command: boolean;
      operands: string[];
      options: Partial<ShellOptions>;
    };

// (1ctx shell-options) bash's grammar: options first, -c a flag like any
// other letter, an o in a group taking the next argument, -- or - ending
// them; the first operand is then the command string or the script
function parseInvocation(name: string, args: string[]): Invocation {
  const fail = (message: string): Invocation => ({
    kind: "error",
    result: { stdout: "", stderr: `${name}: ${message}\n`, exitCode: 2 },
  });
  const options: Partial<ShellOptions> = {};
  const set = (key: keyof ShellOptions | null, on: boolean) => {
    if (key === null) return;
    options[key] = on;
    if (on && key === "vi") options.emacs = false;
    if (on && key === "emacs") options.vi = false;
  };
  let command = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--" || arg === "-") {
      i++;
      break;
    }
    if (arg === "--help") return { kind: "help" };
    if (arg === "--noprofile" || arg === "--norc") {
      i++;
      continue;
    }
    if (arg.startsWith("--")) return fail(`${arg}: invalid option`);
    if (arg.length < 2 || (arg[0] !== "-" && arg[0] !== "+")) break;
    const on = arg[0] === "-";
    i++;
    for (const c of arg.slice(1)) {
      if (c === "c") command = true;
      else if (c === "o") {
        const optName = args[i++];
        if (optName === undefined) {
          return fail(`${arg[0]}o: option requires an argument`);
        }
        if (!LONG_OPTIONS.has(optName)) {
          return fail(`line 0: ${name}: ${optName}: invalid option name`);
        }
        set(LONG_OPTIONS.get(optName) ?? null, on);
      } else if (SHORT_OPTIONS.has(c)) set(SHORT_OPTIONS.get(c) ?? null, on);
      else return fail(`${arg[0]}${c}: invalid option`);
    }
  }
  const operands = args.slice(i);
  if (command && operands.length === 0) {
    return fail("-c: option requires an argument");
  }
  return { kind: "run", command, operands, options };
}

// (1ctx shell-options) bash and sh share the one implementation
async function runShell(
  name: string,
  help: typeof bashHelp,
  args: string[],
  ctx: RuntimeCommandContext,
): Promise<ExecResult> {
  const invocation = parseInvocation(name, args);
  if (invocation.kind === "error") return invocation.result;
  if (invocation.kind === "help") return showHelp(help);
  const { operands, options } = invocation;

  // With -c: bash -c 'command' arg0 arg1 arg2
  // arg0 becomes $0, arg1 becomes $1, arg2 becomes $2
  if (invocation.command) {
    const scriptName = operands[1] || name;
    return executeScript(
      operands[0],
      scriptName,
      operands.slice(2),
      options,
      ctx,
    );
  }

  // No arguments - read script from stdin if available. Decode bytes — a
  // bash script's UTF-8 string literals must reach the parser as text.
  if (operands.length === 0) {
    const stdinText = decodeBytesToUtf8(ctx.stdin);
    if (stdinText.trim()) {
      return executeScript(stdinText, name, [], options, ctx);
    }
    // No stdin - return success (interactive mode not supported)
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  // Read and execute script file
  const scriptPath = operands[0];
  const scriptArgs = operands.slice(1);

  try {
    const fullPath = ctx.fs.resolvePath(ctx.cwd, scriptPath);
    const scriptContent = await ctx.fs.readFile(fullPath);
    return executeScript(scriptContent, scriptPath, scriptArgs, options, ctx);
  } catch (error) { // (1ctx readonly-errors)
    return {
      stdout: "",
      // (1ctx readonly-errors) a file over the read limit says so
      stderr: `${name}: ${scriptPath}: ${readErrorWords(error)}\n`,
      exitCode: 127,
    };
  }
}

async function executeScript(
  script: string,
  scriptName: string,
  scriptArgs: string[],
  shellOptions: Partial<ShellOptions>, // (1ctx shell-options)
  ctx: RuntimeCommandContext,
): Promise<ExecResult> {
  if (!ctx.exec) {
    return {
      stdout: "",
      stderr: "bash: internal error: exec function not available\n",
      exitCode: 1,
    };
  }

  // Build environment for the exec call
  // Include exported environment from parent (for prefix assignments like "FOO=bar exec sh -c '...'")
  // plus positional parameters
  // Use null-prototype object to prevent prototype pollution
  const positionalEnv = mergeToNullPrototype(ctx.exportedEnv || {}, {
    "0": scriptName,
    "#": String(scriptArgs.length),
    "@": scriptArgs.join(" "),
    "*": scriptArgs.join(" "),
  }) as Record<string, string>;
  scriptArgs.forEach((arg, i) => {
    positionalEnv[String(i + 1)] = arg;
  });
  // (1ctx exec-env) a new shell never takes IFS from its environment, as bash does
  if ("IFS" in positionalEnv) positionalEnv.IFS = " \t\n";

  // (1ctx shell-options) blank the shebang line, keeping its newline, so
  // $LINENO and parse errors count lines as bash does
  let scriptToRun = script;
  if (scriptToRun.startsWith("#!")) {
    const firstNewline = scriptToRun.indexOf("\n");
    scriptToRun = firstNewline === -1 ? "" : scriptToRun.slice(firstNewline);
  }

  // Execute the script as-is, preserving newlines for proper parsing
  // The parser needs to see the original structure to correctly handle
  // multi-line constructs like (( ... )) vs ( ( ... ) )
  // Forward our already-byte-shaped stdin verbatim — `stdinKind: "bytes"`
  // tells the nested exec entry to skip the default text-mode UTF-8
  // encoding and avoid double-encoding.
  const nestedExec = ctx.execWithInheritedStdin;
  const result = nestedExec
    ? await nestedExec(scriptToRun, {
        env: positionalEnv,
        // (1ctx exec-env) a child shell sees the exported environment, not the first shell's
        replaceEnv: true,
        cwd: ctx.cwd,
        signal: ctx.signal,
        shellOptions, // (1ctx shell-options)
      })
    : await ctx.exec(scriptToRun, {
        env: positionalEnv,
        // (1ctx exec-env) as above
        replaceEnv: true,
        cwd: ctx.cwd,
        stdin: latin1FromBytes(ctx.stdin),
        stdinKind: "bytes",
        signal: ctx.signal,
        shellOptions, // (1ctx shell-options)
      });
  return result;
}

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "bash",
  flags: [{ flag: "-c", type: "value", valueHint: "string" }],
  stdinType: "text",
};

export const shFlagsForFuzzing: CommandFuzzInfo = {
  name: "sh",
  flags: [{ flag: "-c", type: "value", valueHint: "string" }],
  stdinType: "text",
};
