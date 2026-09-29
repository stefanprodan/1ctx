// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server's side of the command worker: a worker per command, ended
// when the job settles, so a busy loop never holds the thread that
// serves the streams. A job settles exactly once. A message of another
// id, of an unknown shape or after the job settled is dropped, and so is
// a second request under one number, since the commands inside can post
// too. A cancel lets the command stop on its own within a grace; past
// it, or at the deadline, the worker is ended. The worker file is an
// entry point of the compiled binary, where a URL resolves against the
// compile root, so compose.ts builds it and passes it in.

import type { SecureFetch } from "just-bash";
import type { Log } from "../lib/log.ts";
import { CANCEL_GRACE_MS } from "./limits.ts";
import {
  type Answer,
  type CommandCause,
  type CommandPhase,
  type FetchRequest,
  fromWorker,
  type Job,
  owned,
  type ToWorker,
  transferOf,
} from "./protocol.ts";

// what the server answers for the worker: a kept MCP file by its index
// in the job, and curl's fetch, with the command's keys, or null
// without network
export type CommandHooks = {
  kept(index: number): string | Uint8Array | null;
  fetch: SecureFetch | null;
};

export type CommandStops = {
  // the caller's abort: a cancel, then the grace
  signal: AbortSignal;
  // the call's budget: the worker is ended at once
  deadline: AbortSignal;
  // the chat, for the log
  chat: string;
};

export type Settled =
  | { ok: true; answer: Answer }
  | {
      ok: false;
      phase: CommandPhase;
      cause: Exclude<CommandCause, "limit">;
      // the start notice, when the worker got that far
      notice: string;
      error?: Error;
    };

export type CommandWorkers = {
  run(job: Job, hooks: CommandHooks, stops: CommandStops): Promise<Settled>;
  // shutdown: every running job cancelled, then its worker ended
  close(): void;
};

const SHUTTING_DOWN = "the server is shutting down";

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
      const fail = (cause: Exclude<CommandCause, "limit">, error?: Error) =>
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
      function shut() {
        if (!settled) send({ type: "cancel", id });
        fail("abort", new Error(SHUTTING_DOWN));
      }
      const ended = (words: string) =>
        cancelling ? fail("abort") : fail("error", new Error(words));
      const serveKept = (request: number, index: number) => {
        if (index >= job.kept.length) return;
        let data: string | Uint8Array | null = null;
        try {
          data = hooks.kept(index);
        } catch {
          data = null;
        }
        const bytes = data instanceof Uint8Array ? owned(data) : data;
        send(
          { type: "kept", id, request, data: bytes },
          bytes instanceof Uint8Array ? transferOf([bytes]) : [],
        );
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
        hooks.fetch(target, fetchOptions(options, stop.signal)).then(
          (result) => {
            if (settled || cancelling) return;
            const body = owned(result.body);
            send(
              { type: "fetched", id, request, result: { ...result, body } },
              transferOf([body]),
            );
          },
          (error: unknown) => {
            if (settled || cancelling) return;
            send({
              type: "fetched",
              id,
              request,
              error: {
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          },
        );
      };
      worker.onmessage = (event: MessageEvent) => {
        if (settled) return;
        const message = fromWorker(event.data, id);
        if (message === null) return;
        switch (message.type) {
          case "phase":
            phase = message.phase;
            notice = message.notice;
            return;
          case "done":
            if (cancelling) fail("abort");
            else finish({ ok: true, answer: message.answer });
            return;
          case "failed":
            ended(message.message);
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
