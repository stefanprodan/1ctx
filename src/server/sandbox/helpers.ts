// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fixed helpers ride in the binary and go to the sandbox as exec
// arguments, so an image never holds a helper older or newer than the
// server reading its output. Every exec names its interpreter by an
// absolute path under /usr, which the workload cannot write, and runs
// no startup file: python3 -I -S reads no environment, user site or
// site module, and bash --noprofile --norc reads no profile or rc.

import { bytesWords } from "../lib/bytes.ts";
import { SANDBOX_ROOTS } from "./frames.ts";
import fence from "./helpers/fence.sh" with { type: "text" };
import open from "./helpers/open.py" with { type: "text" };
import pull from "./helpers/pull.py" with { type: "text" };
import push from "./helpers/push.py" with { type: "text" };
import walk from "./helpers/walk.py" with { type: "text" };
import wrapper from "./helpers/wrapper.sh" with { type: "text" };

export const HELPER_SOURCES = { fence, open, pull, push, walk, wrapper };

export const PYTHON = "/usr/bin/python3";
export const BASH = "/usr/bin/bash";

// where a command's records go: writable by the workload and never
// synced, so the server checks what it reads there
export const RECORDS = "/sandbox/.1ctx";

// a test runs the helpers with the host's interpreters
export type Interpreters = { python?: string; bash?: string };

const python = (source: string, using?: Interpreters) => [
  using?.python ?? PYTHON,
  "-I",
  "-S",
  "-c",
  source,
];
const bash = (source: string, name: string, using?: Interpreters) => [
  using?.bash ?? BASH,
  "--noprofile",
  "--norc",
  "-c",
  source,
  name,
];

// stdin: the chunks of encodePush, one exec each
export function pushArgv(
  roots: readonly string[] = SANDBOX_ROOTS,
  using?: Interpreters,
): string[] {
  return [...python(push, using), ...roots];
}

// the walk stops with WALK over before it would pass a bound: the
// entries listed, one file's size, the sizes of all files. A file is
// sized before it is read, so a huge or sparse one costs nothing
export type WalkLimits = {
  entries: number;
  fileBytes: number;
  totalBytes: number;
};

export function walkArgv(
  limits: WalkLimits,
  roots: readonly string[] = SANDBOX_ROOTS,
  using?: Interpreters,
): string[] {
  const counts = [limits.entries, limits.fileBytes, limits.totalBytes];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0))
    throw new TypeError("a walk bound is a count");
  return [...python(walk, using), ...counts.map(String), ...roots];
}

// stdin: pullRequest's lines
export function pullArgv(
  roots: readonly string[] = SANDBOX_ROOTS,
  using?: Interpreters,
): string[] {
  return [...python(pull, using), ...roots];
}

// a process's start time from its /proc/<pid>/stat: field 22, counted
// after the last ), since the name before it may hold ) and newlines
export function startTimeOf(stat: string): string | null {
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const started = fields[19];
  return stat.includes(")") && started && /^[0-9]+$/.test(started)
    ? started
    : null;
}

// the keep-alive's pid and start time, both recorded when the lease
// starts; a pid naming another process by then exits 6 and the sandbox
// is recycled
export function fenceArgv(
  keep: number,
  started: string,
  using?: Interpreters,
): string[] {
  if (!Number.isSafeInteger(keep) || keep < 2)
    throw new TypeError("keep is a pid");
  if (!/^[0-9]+$/.test(started)) throw new TypeError("a start time is a count");
  return [...bash(fence, "fence", using), String(keep), started];
}

// what the wrapper's open allows, as makeOpenCommand's caps
export type OpenCaps = {
  docs: boolean;
  maxFiles: number;
  knowledgeFileBytes: number;
  repoFileBytes?: number;
};

export type WrapperOptions = {
  cwd: string;
  // the server's, never reused: it names the records
  id: string;
  command: string;
  // null for a subagent, whose shell has no open
  open: OpenCaps | null;
  records?: string;
  // a test's folder standing for /, where open looks for the trees
  under?: string;
};

// what the wrapper answers over a planted record, before the command
export const RECORDS_EXIST = { code: 126, line: "WRAPPER records exist" };

// at least 128 bits in base64url, so no command can guess a later one's
const ID = /^[A-Za-z0-9_-]{22,64}$/;

// the files a command leaves: the final cwd, raw, and open's copies,
// <n> beside <n>.path holding the escaped path and a newline. The id is
// random per command and never reused, and the server removes the
// records once read; the wrapper refuses to start over a record already
// there (exit 126, WRAPPER records exist)
export function recordPaths(id: string, records = RECORDS) {
  if (!ID.test(id)) throw new TypeError("a command id is a plain name");
  return { cwd: `${records}/${id}.cwd`, opened: `${records}/${id}.opened` };
}

export function wrapperArgv(
  options: WrapperOptions,
  using?: Interpreters,
): string[] {
  recordPaths(options.id);
  const caps = options.open;
  const repo = caps?.repoFileBytes;
  return [
    ...bash(wrapper, "bash", using),
    options.cwd,
    options.id,
    options.command,
    caps ? "on" : "off",
    options.records ?? RECORDS,
    using?.python ?? PYTHON,
    options.under ?? "",
    caps?.docs ? "1" : "0",
    String(caps?.maxFiles ?? 0),
    String(caps?.knowledgeFileBytes ?? 0),
    caps ? bytesWords(caps.knowledgeFileBytes) : "",
    repo === undefined ? "-" : String(repo),
    repo === undefined ? "" : bytesWords(repo),
    open,
  ];
}
