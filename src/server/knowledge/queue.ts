// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Admission for memory-backed work across all area instances: commands,
// archives and staging share one process-wide bound on mounted bytes,
// and a user runs one upload at a time.

import { UPLOAD_RUNNING } from "../../shared/uploads.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, ServiceUnavailable } from "../lib/errors.ts";
import { Queue } from "../lib/queue.ts";
import { ARCHIVE_DEADLINE_MS, KNOWLEDGE_COMMANDS_IN_FLIGHT } from "./limits.ts";

const processQueue = new Queue(KNOWLEDGE_COMMANDS_IN_FLIGHT);
const uploads = new Set<string>();

export const acquireProcess = (signal: AbortSignal) =>
  processQueue.acquire(signal);

export function acquireUpload(userId: string): () => void {
  if (uploads.has(userId)) throw new Conflict(UPLOAD_RUNNING);
  uploads.add(userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    uploads.delete(userId);
  };
}

export async function withUpload<Input, Result>(
  clock: Clock,
  userId: string,
  req: Request,
  parse: () => Input,
  work: (
    input: Input,
    signal: AbortSignal,
    running: () => void,
  ) => Promise<Result>,
): Promise<Result> {
  const releaseUser = acquireUpload(userId);
  const deadline = new AbortController();
  const signal = AbortSignal.any([req.signal, deadline.signal]);
  const ends = clock() + ARCHIVE_DEADLINE_MS;
  const busy = new ServiceUnavailable("the server is busy, try again");
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const expire = () => {
    if (!finished) deadline.abort(busy);
  };
  const running = () => {
    if (clock() >= ends) expire();
    signal.throwIfAborted();
  };
  try {
    if (clock.sleep) void clock.sleep(ARCHIVE_DEADLINE_MS).then(expire);
    else timer = setTimeout(expire, ARCHIVE_DEADLINE_MS);
    const input = parse();
    release = await acquireProcess(signal);
    running();
    return await work(input, signal, running);
  } catch (error) {
    if (deadline.signal.aborted) throw busy;
    if (req.signal.aborted) throw new BadRequest("upload was aborted");
    throw error;
  } finally {
    finished = true;
    clearTimeout(timer);
    release?.();
    releaseUser();
  }
}
