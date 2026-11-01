// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Process slots and the one-upload-per-user admission, process-wide. A
// caller's own bound is taken before the slot, never inside one, so a
// wait for it never idles a slot that commands share.

import { UPLOAD_RUNNING } from "../../shared/uploads.ts";
import { after, type Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, ServiceUnavailable } from "../lib/errors.ts";
import { Queue } from "../lib/queue.ts";
import { ARCHIVE_DEADLINE_MS, PROCESS_SLOTS } from "./limits.ts";

const processQueue = new Queue(PROCESS_SLOTS);
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
  // a narrower bound of the caller's, waited on under the same deadline
  gate?: (signal: AbortSignal) => Promise<() => void>,
): Promise<Result> {
  const releaseUser = acquireUpload(userId);
  const deadline = new AbortController();
  const signal = AbortSignal.any([req.signal, deadline.signal]);
  const ends = clock() + ARCHIVE_DEADLINE_MS;
  const busy = new ServiceUnavailable("the server is busy, try again");
  let finished = false;
  let stopTimer = () => {};
  let release: (() => void) | undefined;
  let releaseGate: (() => void) | undefined;
  const expire = () => {
    if (!finished) deadline.abort(busy);
  };
  const running = () => {
    if (clock() >= ends) expire();
    signal.throwIfAborted();
  };
  try {
    stopTimer = after(clock, ARCHIVE_DEADLINE_MS, expire);
    const input = parse();
    if (gate !== undefined) {
      releaseGate = await gate(signal);
      running();
    }
    release = await acquireProcess(signal);
    running();
    return await work(input, signal, running);
  } catch (error) {
    if (deadline.signal.aborted) throw busy;
    if (req.signal.aborted) throw new BadRequest("upload was aborted");
    throw error;
  } finally {
    finished = true;
    stopTimer();
    release?.();
    releaseGate?.();
    releaseUser();
  }
}
