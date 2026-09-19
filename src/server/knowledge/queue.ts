// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Admission for memory-backed commands across all area instances. A
// process-wide bound limits mounted bytes, while cancellation removes a
// waiter before it can build a filesystem its caller no longer needs.
// One command per session at a time, so parallel calls of a round never
// mount the same scratch revision; the held set keeps the sweep off it.

import { UPLOAD_RUNNING } from "../../shared/uploads.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, ServiceUnavailable } from "../lib/errors.ts";
import { ARCHIVE_DEADLINE_MS, KNOWLEDGE_COMMANDS_IN_FLIGHT } from "./limits.ts";

class Queue {
  active = 0;
  private waiting = new Set<() => void>();

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.waiting.delete(start);
        reject(signal.reason);
      };
      const start = () => {
        this.waiting.delete(start);
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiting.values().next().value?.();
        });
      };
      if (signal.aborted) {
        reject(signal.reason);
      } else if (this.active < this.limit) {
        start();
      } else {
        signal.addEventListener("abort", cancel, { once: true });
        this.waiting.add(start);
      }
    });
  }
}

const processQueue = new Queue(KNOWLEDGE_COMMANDS_IN_FLIGHT);
const sessions = new Map<string, Queue>();
const uploads = new Set<string>();

export const acquire = (signal: AbortSignal) => processQueue.acquire(signal);

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
    release = await acquire(signal);
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

export function heldSessions(): ReadonlySet<string> {
  return new Set(sessions.keys());
}

export async function acquireSession(
  sessionId: string,
  signal: AbortSignal,
): Promise<() => void> {
  signal.throwIfAborted();
  let queue = sessions.get(sessionId);
  if (queue === undefined) {
    queue = new Queue(1);
    sessions.set(sessionId, queue);
  }
  const release = await queue.acquire(signal);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (queue.active === 0) sessions.delete(sessionId);
  };
}
