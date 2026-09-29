/**
 * (1ctx) What each command answers to its version flag, as the tool it
 * follows answers it, so a script reading the version from the first line
 * works. Commands with their own parser for it (awk, grep, rg, jq, yq,
 * curl) and bash's builtins, which take no version flag, are not here.
 */

const COREUTILS = [
  "base64",
  "basename",
  "cat",
  "chmod",
  "comm",
  "cp",
  "cut",
  "date",
  "dirname",
  "du",
  "env",
  "expand",
  "expr",
  "fold",
  "head",
  "join",
  "ln",
  "ls",
  "md5sum",
  "mkdir",
  "mv",
  "nl",
  "od",
  "paste",
  "printenv",
  "readlink",
  "rm",
  "rmdir",
  "seq",
  "sha1sum",
  "sha256sum",
  "sleep",
  "sort",
  "split",
  "stat",
  "tac",
  "tail",
  "tee",
  "timeout",
  "touch",
  "tr",
  "unexpand",
  "uniq",
  "wc",
  "whoami",
];

// these stop reading options at the first operand, which may be a command
const FIRST_ONLY = new Set(["env", "timeout", "expr"]);

interface Version {
  /** the flags that ask for it, as the first argument */
  flags: string[];
  /** getopt_long order: --version anywhere before -- asks too */
  anywhere?: boolean;
  /** the tool's own first line */
  line: string;
  /** what it follows, for the second line */
  follows: string;
}

const BASH: Version = {
  flags: ["--version"],
  line: "GNU bash, version 5.3.15(1)-release",
  follows: "GNU bash 5.3",
};

const VERSIONS: Record<string, Version> = {
  ...Object.fromEntries(
    COREUTILS.map((name) => [
      name,
      {
        flags: ["--version"],
        anywhere: !FIRST_ONLY.has(name),
        line: `${name} (GNU coreutils) 9.11`,
        follows: "GNU coreutils 9.11",
      },
    ]),
  ),
  bash: BASH,
  sh: BASH,
  sed: {
    flags: ["--version"],
    anywhere: true,
    line: "sed (GNU sed) 4.10",
    follows: "GNU sed 4.10",
  },
  find: {
    flags: ["--version", "-version"],
    line: "find (GNU findutils) 4.11.0",
    follows: "GNU findutils 4.11.0",
  },
  tar: {
    flags: ["--version"],
    anywhere: true,
    line: "tar (GNU tar) 1.35",
    follows: "GNU tar 1.35",
  },
  gzip: {
    flags: ["--version", "-V"],
    anywhere: true,
    line: "gzip 1.15",
    follows: "GNU gzip 1.15",
  },
  gunzip: {
    flags: ["--version", "-V"],
    anywhere: true,
    line: "gunzip (gzip) 1.15",
    follows: "GNU gzip 1.15",
  },
  zcat: {
    flags: ["--version", "-V"],
    anywhere: true,
    line: "zcat (gzip) 1.15",
    follows: "GNU gzip 1.15",
  },
  file: {
    flags: ["--version", "-v"],
    anywhere: true,
    line: "file-5.48",
    follows: "file 5.48",
  },
  column: {
    flags: ["--version", "-V"],
    anywhere: true,
    line: "column from util-linux 2.42.4",
    follows: "util-linux 2.42.4",
  },
  rev: {
    flags: ["--version", "-V"],
    anywhere: true,
    line: "rev from util-linux 2.42.4",
    follows: "util-linux 2.42.4",
  },
  strings: {
    flags: ["--version", "-v", "-V"],
    anywhere: true,
    line: "GNU strings (GNU Binutils) 2.47",
    follows: "GNU Binutils 2.47",
  },
  tree: {
    flags: ["--version"],
    anywhere: true,
    line: "tree v2.3.2",
    follows: "tree 2.3.2",
  },
  which: {
    flags: ["--version", "-v", "-V"],
    anywhere: true,
    line: "GNU which v2.25",
    follows: "GNU which 2.25",
  },
  hostname: {
    flags: ["--version", "-V"],
    anywhere: true,
    line: "hostname (GNU inetutils) 2.8",
    follows: "GNU inetutils 2.8",
  },
  xan: {
    flags: ["--version", "-V"],
    line: "xan 0.61.0",
    follows: "xan 0.61.0",
  },
};

/** The version text when the first argument asks for it, else null. */
export function versionAnswer(name: string, args: string[]): string | null {
  const version = VERSIONS[name];
  if (!version) return null;
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const asked =
    version.flags.includes(args[0] ?? "") ||
    (version.anywhere === true && options.includes("--version"));
  if (!asked) return null;
  return (
    `${version.line} (just-bash, compatible)\n` +
    `A sandboxed ${name} that follows ${version.follows}; see ${name} --help.\n`
  );
}
