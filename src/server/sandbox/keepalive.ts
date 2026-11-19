// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The keep-alive's pid, read once when a sandbox is made, before any
// command ran in it: the fence after a command that ran alone spares it
// and pid 1, and stops every other process of the workload's user.

import type { Gateway } from "./gateway.ts";
import { startTimeOf } from "./helpers.ts";
import { KEEP_ALIVE, SANDBOX_ENV } from "./spec.ts";

// the most of the script's output read
const OUTPUT_BYTES = 4096;

// bash builtins only, so the walk starts no process it could list: each
// /proc entry whose argv is exactly the keep-alive's, by pid
export const KEEP_ALIVE_SCRIPT = [
  "for d in /proc/[0-9]*; do",
  "  mapfile -d '' -t a < \"$d/cmdline\" 2>/dev/null || continue",
  `  [ "\${#a[@]}" = ${KEEP_ALIVE.length} ] || continue`,
  ...KEEP_ALIVE.map((arg, i) => `  [ "\${a[${i}]}" = '${arg}' ] || continue`),
  // biome-ignore lint/suspicious/noTemplateCurlyInString: bash, not a template
  '  echo "${d#/proc/}"',
  "done",
].join("\n");

export const KEEP_ALIVE_COMMAND = [
  "/usr/bin/bash",
  "--noprofile",
  "--norc",
  "-c",
  KEEP_ALIVE_SCRIPT,
];

// the one pid the script printed; null for none, several or anything
// else, since a fence that spares the wrong process proves nothing
export function keepAlivePid(stdout: string): number | null {
  const lines = stdout.split("\n").filter((line) => line !== "");
  if (lines.length !== 1 || !/^[1-9][0-9]{0,9}$/.test(lines[0]!)) return null;
  const pid = Number(lines[0]);
  return pid > 1 ? pid : null;
}

// one exec of the script, never a login shell; a throw when the sandbox
// has no single keep-alive, so it is never leased
export async function readKeepAlive(
  gateway: Gateway,
  sandbox: string,
  signal: AbortSignal,
): Promise<number> {
  let code: number | null = null;
  let stdout = "";
  const decoder = new TextDecoder();
  for await (const event of gateway.exec({
    sandbox,
    command: KEEP_ALIVE_COMMAND,
    environment: { ...SANDBOX_ENV },
    signal,
  })) {
    if ("exit" in event) code = event.exit;
    else if (event.stream === "stdout" && stdout.length < OUTPUT_BYTES) {
      stdout += decoder.decode(event.data, { stream: true });
    }
  }
  const pid = code === 0 ? keepAlivePid(stdout) : null;
  if (pid === null) throw new Error("no single keep-alive process");
  return pid;
}

// the keep-alive's start time, field 22 of its stat: the fence checks
// it, so a pid the kernel gave to another process is never spared
export const START_TIME_COMMAND = [
  "/usr/bin/bash",
  "--noprofile",
  "--norc",
  "-c",
  'builtin read -r -d "" s <"/proc/$1/stat"; builtin printf %s "$s"',
  "stat",
];

export async function readStartTime(
  gateway: Gateway,
  sandbox: string,
  pid: number,
  signal: AbortSignal,
): Promise<string> {
  let code: number | null = null;
  let stdout = "";
  const decoder = new TextDecoder();
  for await (const event of gateway.exec({
    sandbox,
    command: [...START_TIME_COMMAND, String(pid)],
    environment: { ...SANDBOX_ENV },
    signal,
  })) {
    if ("exit" in event) code = event.exit;
    else if (event.stream === "stdout" && stdout.length < OUTPUT_BYTES) {
      stdout += decoder.decode(event.data, { stream: true });
    }
  }
  const started = code === 0 ? startTimeOf(stdout) : null;
  if (started === null) throw new Error("no start time for the keep-alive");
  return started;
}
