// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The command's one exec, through the wrapper: its output kept within
// the result's cut, and its exit as the command gave it. Only the
// wrapper's refusal over a planted record is ours; a real shell's exit
// 124 or 126 is the command's own.

import type { CommandCredential, Job } from "../bash/index.ts";
import { MAX_OPENS_PER_COMMAND } from "../bash/index.ts";
import { Capped, drain, type Execs } from "./execs.ts";
import { RECORDS_EXIST, wrapperArgv } from "./helpers.ts";
import { keptText, outputBytes } from "./scrub.ts";
import { SANDBOX_ENV } from "./spec.ts";

// a fresh 128-bit id per command, base64url: no command guesses the next
export function commandId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
    "base64url",
  );
}

export type Launched = {
  stdout: string;
  stderr: string;
  // null when the exec threw, with the error
  code: number | null;
  error?: unknown;
  // the wrapper refused to start over a planted record
  refusedStart: boolean;
};

export async function launch(
  on: Execs,
  job: Job,
  start: string,
  id: string,
  credentials: readonly CommandCredential[],
): Promise<Launched> {
  const kept = outputBytes(job.resultCut, credentials);
  const stdout = new Capped(kept);
  const stderr = new Capped(kept);
  const shown = (stream: Capped) =>
    keptText(stream.text(), stream.dropped > 0, credentials);
  const open = !job.subagent;
  let code: number | null = null;
  let error: unknown;
  try {
    code = await drain(
      on.gateway.exec({
        sandbox: on.sandbox,
        command: wrapperArgv({
          cwd: start,
          id,
          open: open
            ? {
                docs: job.docs,
                maxFiles: MAX_OPENS_PER_COMMAND,
                knowledgeFileBytes: job.knowledgeFileBytes,
                ...(job.repos.length > 0
                  ? { repoFileBytes: job.repoFileBytes }
                  : {}),
              }
            : null,
        }),
        // the wrapper reads the command from stdin: the gateway refuses
        // an argument past 32 KiB
        stdin: new TextEncoder().encode(job.command),
        environment: { ...SANDBOX_ENV },
        signal: on.signal,
      }),
      (stream, data) => (stream === "stdout" ? stdout : stderr).push(data),
    );
  } catch (thrown) {
    error = thrown;
  }
  return {
    stdout: shown(stdout),
    stderr: shown(stderr),
    code,
    ...(code === null ? { error } : {}),
    // the wrapper says nothing else before it refuses
    refusedStart:
      code === RECORDS_EXIST.code &&
      stdout.size === 0 &&
      stderr.text() === `${RECORDS_EXIST.line}\n`,
  };
}
