// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The execs of one command, each a single attempt on the command's
// signal: the push, the command, the fence, the walk, the pull, a
// folder check and the records' removal. Any of them that fails throws
// a StepFailure, after which the sandbox is recycled; what a sandbox
// printed is read only within its bounds.

import { type PushManifest, parsePushResult, pushChunks } from "./frames.ts";
import { type ExecEvent, type Gateway, SandboxUnavailable } from "./gateway.ts";
import {
  BASH,
  fenceArgv,
  pullArgv,
  pushArgv,
  RECORDS,
  type WalkLimits,
  walkArgv,
} from "./helpers.ts";
import {
  type PullBounds,
  PullDecoder,
  type PullFrame,
  pullBatches,
  pullRequest,
} from "./pull.ts";
import { SANDBOX_ENV } from "./spec.ts";
import { type WalkBounds, WalkDecoder, type WalkEntry } from "./walk.ts";

export type Step =
  | "push"
  | "command"
  | "fence"
  | "walk"
  | "pull"
  | "check"
  | "records";

// a step that did not end as it must; reason is a closed word for the log
export class StepFailure extends Error {
  constructor(
    readonly step: Step,
    readonly reason: string,
  ) {
    super(`sandbox ${step} failed: ${reason}`);
  }
}

// the words a refused read back saves nothing with
export function refusal(error: StepFailure): string {
  if (error.step === "fence")
    return "the command's processes could not all be stopped, so nothing was saved";
  if (error.step === "walk" && error.reason === "unicode")
    return "a file name is not UTF-8, so nothing was saved";
  if (
    (error.step === "walk" || error.step === "records") &&
    error.reason === "credential"
  )
    return "a file name held a credential, so nothing was saved";
  if (error.step === "walk" && error.reason === "linked")
    return "a file has more than one name (a hard link), so nothing was saved";
  if (
    error.step === "walk" &&
    ["over", "entries", "names", "bytes"].includes(error.reason)
  )
    return "the files are past the limits, so nothing was saved";
  return "the files could not be read back, so nothing was saved";
}

const FENCE_WORDS = new Set(["usage", "keep", "unstable", "survivors"]);

// what a helper prints past its own few lines is never read
const SMALL = 4096;

export type Execs = {
  gateway: Gateway;
  sandbox: string;
  signal: AbortSignal;
};

// at most `cap` bytes kept; the rest is read and dropped, so a stream
// is drained to its exit and never stalls on a full pipe
export class Capped {
  private parts: Uint8Array[] = [];
  size = 0;
  dropped = 0;
  constructor(private readonly cap: number) {}
  push(data: Uint8Array): void {
    const room = this.cap - this.size;
    if (room <= 0) {
      this.dropped += data.byteLength;
      return;
    }
    const kept = data.byteLength <= room ? data : data.subarray(0, room);
    this.parts.push(new Uint8Array(kept));
    this.size += kept.byteLength;
    this.dropped += data.byteLength - kept.byteLength;
  }
  text(): string {
    return new TextDecoder().decode(Buffer.concat(this.parts));
  }
}

// every event to its sink, then the exit; a stream without one throws
export async function drain(
  events: AsyncIterable<ExecEvent>,
  sink: (stream: "stdout" | "stderr", data: Uint8Array) => void,
): Promise<number> {
  let code: number | null = null;
  for await (const event of events) {
    if ("exit" in event) code = event.exit;
    else sink(event.stream, event.data);
  }
  if (code === null) throw new Error("exec ended without an exit");
  return code;
}

async function small(
  on: Execs,
  step: Step,
  command: string[],
  stdin?: Uint8Array,
): Promise<{ code: number; stdout: string }> {
  const out = new Capped(SMALL);
  try {
    const code = await drain(
      on.gateway.exec({
        sandbox: on.sandbox,
        command,
        environment: { ...SANDBOX_ENV },
        signal: on.signal,
        ...(stdin ? { stdin } : {}),
      }),
      (stream, data) => {
        if (stream === "stdout") out.push(data);
      },
    );
    return { code, stdout: out.text() };
  } catch (error) {
    if (on.signal.aborted || error instanceof SandboxUnavailable) throw error;
    throw new StepFailure(step, "transport");
  }
}

// one exec per chunk, each made when the one before it was applied
export async function push(on: Execs, manifest: PushManifest): Promise<number> {
  let sent = 0;
  for (const chunk of pushChunks(manifest)) {
    const { code, stdout } = await small(on, "push", pushArgv(), chunk);
    const result = parsePushResult(stdout);
    if (code !== 0 || !result.ok) throw new StepFailure("push", "refused");
    sent++;
  }
  return sent;
}

export async function fence(
  on: Execs,
  keep: number,
  started: string,
): Promise<void> {
  const { code, stdout } = await small(on, "fence", fenceArgv(keep, started));
  if (code !== 0 || !stdout.startsWith("FENCE ok")) {
    const word = /^FENCE (\w+)/.exec(stdout)?.[1];
    // the fence's own words only: its output is the sandbox's to forge
    throw new StepFailure(
      "fence",
      word !== undefined && FENCE_WORDS.has(word) ? word : "exit",
    );
  }
}

export async function walk(
  on: Execs,
  limits: WalkLimits,
  bounds: WalkBounds,
  roots: readonly string[],
): Promise<WalkEntry[]> {
  const decoder = new WalkDecoder(roots, bounds);
  let code: number;
  try {
    code = await drain(
      on.gateway.exec({
        sandbox: on.sandbox,
        command: walkArgv(limits, roots),
        environment: { ...SANDBOX_ENV },
        signal: on.signal,
      }),
      (stream, data) => {
        if (stream === "stdout") decoder.push(data);
      },
    );
  } catch (error) {
    if (on.signal.aborted || error instanceof SandboxUnavailable) throw error;
    throw new StepFailure("walk", "transport");
  }
  const result = decoder.end();
  if (!result.ok) throw new StepFailure("walk", result.reason);
  if (code !== 0) throw new StepFailure("walk", "exit");
  return result.entries;
}

// The paths in batches, one exec each under the gateway's request
// limit, the total bound counted across them all.
export async function pull(
  on: Execs,
  escaped: readonly string[],
  bounds: PullBounds,
  roots: readonly string[],
): Promise<PullFrame[]> {
  const frames: PullFrame[] = [];
  let spent = 0;
  for (const batch of pullBatches(escaped)) {
    const got = await pullOnce(
      on,
      batch,
      { ...bounds, totalBytes: bounds.totalBytes - spent },
      roots,
    );
    for (const frame of got) if (!frame.missing) spent += frame.data.byteLength;
    frames.push(...got);
  }
  return frames;
}

async function pullOnce(
  on: Execs,
  escaped: readonly string[],
  bounds: PullBounds,
  roots: readonly string[],
): Promise<PullFrame[]> {
  const decoder = new PullDecoder(roots, bounds, escaped);
  // the exec ends at the decoder's first refusal: what follows can only
  // be dropped, so it is never read
  const stop = new AbortController();
  let code: number;
  try {
    code = await drain(
      on.gateway.exec({
        sandbox: on.sandbox,
        command: pullArgv(bounds.fileBytes, roots),
        stdin: pullRequest(escaped),
        environment: { ...SANDBOX_ENV },
        signal: AbortSignal.any([on.signal, stop.signal]),
      }),
      (stream, data) => {
        if (stream !== "stdout") return;
        const failed = decoder.push(data);
        if (failed === null) return;
        stop.abort();
        throw new StepFailure("pull", failed.reason);
      },
    );
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    if (on.signal.aborted || error instanceof SandboxUnavailable) throw error;
    throw new StepFailure("pull", "transport");
  }
  const result = decoder.end();
  if (!result.ok) throw new StepFailure("pull", result.reason);
  if (code !== 0) throw new StepFailure("pull", "exit");
  return result.frames;
}

// a folder in the mounted repositories, links followed as the kernel
// follows them there
export async function isFolder(on: Execs, path: string): Promise<boolean> {
  const { code } = await small(on, "check", [
    BASH,
    "--noprofile",
    "--norc",
    "-c",
    "[[ -d $1 ]]",
    "check",
    path,
  ]);
  if (code === 0) return true;
  if (code === 1) return false;
  throw new StepFailure("check", "exit");
}

// The records folder emptied, its contents only, or only one command's
// records while others run there: find deletes depth first and follows
// no link, the starting point included. An id is base64url, which no
// pattern reads.
export async function removeRecords(
  on: Execs,
  id: string | null,
): Promise<void> {
  const only =
    id === null
      ? []
      : [
          "(",
          "-path",
          `${RECORDS}/${id}.cwd`,
          "-o",
          "-path",
          `${RECORDS}/${id}.opened`,
          "-o",
          "-path",
          `${RECORDS}/${id}.opened/*`,
          ")",
        ];
  const { code } = await small(on, "records", [
    "/usr/bin/find",
    RECORDS,
    "-mindepth",
    "1",
    ...only,
    "-delete",
  ]);
  if (code !== 0) throw new StepFailure("records", "exit");
}
