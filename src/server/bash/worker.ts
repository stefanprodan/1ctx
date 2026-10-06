// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One worker per command, ended when the job settles; compose.ts builds
// its URL.

import type { SecureFetch } from "just-bash";
import { messageOf } from "../lib/errors.ts";
import type { Log } from "../lib/log.ts";
import {
  type Answer,
  type CommandCause,
  type CommandPhase,
  type FetchRequest,
  fromWorker,
  type Job,
  MALFORMED,
  owned,
  type ToWorker,
  transferOf,
} from "./protocol.ts";

// what the server answers for the worker: a kept MCP file by its index
// in the job, and curl's fetch, with the command's keys, or null
// without network
export type CommandHooks = {
  kept(index: number): Uint8Array | null;
  fetch: SecureFetch | null;
};

export type CommandStops = {
  // the caller's abort: a cancel, then the grace
  signal: AbortSignal;
  // the call's budget: the worker is ended at once
  deadline: AbortSignal;
  // the chat, for the log
  chat: string;
  // each phase the worker reports, for a caller that waits on one
  phase?: (phase: "run" | "diff") => void;
};

type WorkerCause = Exclude<CommandCause, "limit" | "busy">;

export type Settled =
  | { ok: true; answer: Answer }
  | {
      ok: false;
      phase: CommandPhase;
      cause: WorkerCause;
      // the start notice, when the worker got that far
      notice: string;
      error?: Error;
    };

export type CommandWorkers = {
  run(job: Job, hooks: CommandHooks, stops: CommandStops): Promise<Settled>;
  // shutdown: every running job's worker ended
  close(): void;
};

// a cancelled command's moment to stop on its own before its worker is
// ended
export const CANCEL_GRACE_MS = 500;

const SHUTTING_DOWN = "the server is shutting down";
const KEPT_FAILED = "the kept file could not be read";

function fetchOptions(options: FetchRequest, signal: AbortSignal) {
  const { headers, ...rest } = options;
  return {
    ...rest,
    ...(headers === undefined ? {} : { headers: Object.fromEntries(headers) }),
    signal,
  };
}

export function commandWorkers(
  url: URL,
  log: Log,
  graceMs = CANCEL_GRACE_MS,
): CommandWorkers {
  const live = new Set<() => void>();
  let closed = false;

  function run(
    job: Job,
    hooks: CommandHooks,
    stops: CommandStops,
  ): Promise<Settled> {
    return new Promise<Settled>((resolve) => {
      let phase: CommandPhase = "mount";
      let notice = "";
      if (closed || stops.signal.aborted || stops.deadline.aborted) {
        resolve({
          ok: false,
          phase,
          cause: stops.deadline.aborted ? "deadline" : "abort",
          notice,
          ...(closed ? { error: new Error(SHUTTING_DOWN) } : {}),
        });
        return;
      }
      const id = crypto.randomUUID();
      // the server's fetches for this job
      const stop = new AbortController();
      const served = new Set<number>();
      const fetches = new Map<number, AbortController>();
      let cancelling = false;
      let settled = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const worker = new Worker(url);
      const send = (message: ToWorker, transfer: ArrayBuffer[] = []) =>
        worker.postMessage(message, transfer);
      const finish = (result: Settled) => {
        if (settled) return;
        settled = true;
        clearTimeout(grace);
        stops.signal.removeEventListener("abort", cancel);
        stops.deadline.removeEventListener("abort", expire);
        live.delete(shut);
        stop.abort();
        worker.terminate();
        resolve(result);
      };
      const fail = (cause: WorkerCause, error?: Error) =>
        finish({
          ok: false,
          phase,
          cause,
          notice,
          ...(error ? { error } : {}),
        });
      function cancel() {
        if (settled || cancelling) return;
        cancelling = true;
        stop.abort();
        send({ type: "cancel", id });
        grace = setTimeout(() => {
          // a command that never yields, which only ending its worker stops
          log.warn("command cancel unanswered", {
            chat: stops.chat,
            phase,
            duration: graceMs,
          });
          fail("abort");
        }, graceMs);
      }
      function expire() {
        fail("deadline");
      }
      // ending the worker is the shutdown; a cancel first would change nothing
      function shut() {
        fail("abort", new Error(SHUTTING_DOWN));
      }
      const ended = (words: string) =>
        cancelling ? fail("abort") : fail("error", new Error(words));
      const serveKept = (request: number, index: number) => {
        // a failed read, or one past the job's list, which the worker never
        // asks for, is answered as an error the command sees; a row gone
        // since the mount reads empty, as it always has
        let bytes: Uint8Array;
        try {
          if (index >= job.kept.length) throw new Error("not in the job");
          bytes = owned(hooks.kept(index) ?? new Uint8Array());
        } catch {
          send({ type: "kept", id, request, error: KEPT_FAILED });
          return;
        }
        send({ type: "kept", id, request, data: bytes }, transferOf([bytes]));
      };
      const serveFetch = (
        request: number,
        target: string,
        options: FetchRequest,
      ) => {
        if (hooks.fetch === null) {
          send({
            type: "fetched",
            id,
            request,
            error: { name: "Error", message: "network is off" },
          });
          return;
        }
        // its own stop, so curl giving up on it (timeout) ends it alone
        const own = new AbortController();
        fetches.set(request, own);
        const signal = AbortSignal.any([stop.signal, own.signal]);
        hooks.fetch(target, fetchOptions(options, signal)).then(
          (result) => {
            fetches.delete(request);
            if (settled || cancelling || own.signal.aborted) return;
            const body = owned(result.body);
            send(
              { type: "fetched", id, request, result: { ...result, body } },
              transferOf([body]),
            );
          },
          (error: unknown) => {
            fetches.delete(request);
            if (settled || cancelling || own.signal.aborted) return;
            send({
              type: "fetched",
              id,
              request,
              error: {
                name: error instanceof Error ? error.name : "Error",
                message: messageOf(error),
              },
            });
          },
        );
      };
      worker.onmessage = (event: MessageEvent) => {
        if (settled) return;
        const message = fromWorker(event.data, id);
        if (message === null) return;
        if (message === MALFORMED) {
          log.warn("command answer malformed", { chat: stops.chat, phase });
          ended("the command worker answered out of protocol");
          return;
        }
        switch (message.type) {
          case "phase":
            phase = message.phase;
            notice = message.notice;
            stops.phase?.(message.phase);
            return;
          case "done":
            if (cancelling) fail("abort");
            else finish({ ok: true, answer: message.answer });
            return;
          case "failed":
            ended(message.message);
            return;
          case "abort":
            fetches.get(message.request)?.abort();
            fetches.delete(message.request);
            return;
          case "kept":
          case "fetch":
            if (cancelling || served.has(message.request)) return;
            served.add(message.request);
            if (message.type === "kept")
              serveKept(message.request, message.index);
            else serveFetch(message.request, message.url, message.options);
            return;
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        ended("the command worker failed");
      };
      worker.addEventListener("close", () =>
        ended("the command worker stopped"),
      );
      live.add(shut);
      stops.signal.addEventListener("abort", cancel, { once: true });
      stops.deadline.addEventListener("abort", expire, { once: true });
      const files = [...job.knowledge, ...job.scratch, ...job.uploads];
      for (const file of files) file.data = owned(file.data);
      try {
        send(
          { type: "job", id, job },
          transferOf(files.map((file) => file.data)),
        );
      } catch (error) {
        fail(
          "error",
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  return {
    run,
    close() {
      closed = true;
      for (const shut of [...live]) shut();
    },
  };
}
