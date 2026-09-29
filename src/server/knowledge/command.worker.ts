// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A bash command runs here, off the thread that serves every stream: a
// busy loop holds this thread alone, and the server ends the worker. The
// worker builds the mount from the posted bytes, runs just-bash, reads
// the tree back and answers once. It never opens the database or holds
// a key: a kept MCP file and a fetch are requests the server answers.

import {
  Bash,
  decodeBytesToUtf8,
  type FetchResult,
  InMemoryFs,
  type SecureFetch,
  stdoutAsBytes,
} from "just-bash";
import { KNOWLEDGE_COMMANDS } from "./commands.ts";
import { makeOpenCommand, type OpenedRecord, underKnowledge } from "./open.ts";
import {
  type Answer,
  type FetchRequest,
  type FromWorker,
  type Job,
  type ToWorker,
  transferOf,
} from "./protocol.ts";
import { diff, executionLimits, notices, savedCwd } from "./tree.ts";

declare var self: Worker;

type Waiting = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type Running = {
  controller: AbortController;
  waiting: Map<number, Waiting>;
  next: number;
};

const jobs = new Map<string, Running>();

function post(message: FromWorker, transfer: ArrayBuffer[] = []): void {
  self.postMessage(message, transfer);
}

// a request to the server, answered once; a job's cancel fails it
function ask(
  id: string,
  running: Running,
  message:
    | { type: "kept"; index: number }
    | { type: "fetch"; url: string; options: FetchRequest },
): Promise<unknown> {
  const request = running.next++;
  return new Promise((resolve, reject) => {
    const signal = running.controller.signal;
    if (signal.aborted) {
      reject(new Error("The operation was aborted."));
      return;
    }
    running.waiting.set(request, { resolve, reject });
    post({ ...message, id, request });
  });
}

function answer(id: string, request: number, value: unknown, error?: Error) {
  const running = jobs.get(id);
  const waiting = running?.waiting.get(request);
  if (running === undefined || waiting === undefined) return;
  running.waiting.delete(request);
  if (error === undefined) waiting.resolve(value);
  else waiting.reject(error);
}

function headerPairs(
  headers: Headers | Record<string, string> | undefined,
): [string, string][] | undefined {
  if (headers === undefined) return undefined;
  return headers instanceof Headers
    ? [...headers.entries()]
    : Object.entries(headers);
}

function workerFetch(id: string, running: Running): SecureFetch {
  return async (url, options = {}) => {
    const request: FetchRequest = {};
    if (options.method !== undefined) request.method = options.method;
    const headers = headerPairs(options.headers);
    if (headers !== undefined) request.headers = headers;
    if (options.body !== undefined) request.body = options.body;
    if (options.followRedirects !== undefined)
      request.followRedirects = options.followRedirects;
    if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;
    if (options.maxRedirects !== undefined)
      request.maxRedirects = options.maxRedirects;
    return (await ask(id, running, {
      type: "fetch",
      url,
      options: request,
    })) as FetchResult;
  };
}

async function run(id: string, job: Job, running: Running): Promise<Answer> {
  const signal = running.controller.signal;
  const fs = new InMemoryFs({}, { maxTotalBytes: job.mountBytes });
  if (job.docs) fs.mkdirSync("/knowledge", { recursive: true });
  fs.mkdirSync("/tmp", { recursive: true });
  fs.mkdirSync("/uploads", { recursive: true });
  // each file keeps the time it last changed, so ls -t and ls -l tell
  // the newest apart
  for (const file of job.knowledge)
    fs.writeFileSync(`/knowledge/${file.name}`, file.data, undefined, {
      mtime: new Date(file.mtime),
    });
  for (const file of job.scratch)
    fs.writeFileSync(`/tmp/${file.name}`, file.data, undefined, {
      mode: file.mode,
      mtime: new Date(file.mtime),
    });
  for (const file of job.uploads)
    fs.writeFileSync(`/uploads/${file.name}`, file.data, undefined, {
      mtime: new Date(file.mtime),
    });
  // a folder, the roots too, takes its newest file's time, so ls -t
  // never puts every folder above every file
  const folders = new Map<string, number>();
  const trees = [
    ["/knowledge", job.knowledge],
    ["/tmp", job.scratch],
    ["/uploads", job.uploads],
  ] as const;
  for (const [root, files] of trees)
    for (const file of files) {
      let path = `${root}/${file.name}`;
      while (path !== root) {
        path = path.slice(0, path.lastIndexOf("/"));
        folders.set(path, Math.max(folders.get(path) ?? 0, file.mtime));
      }
    }
  for (const [path, mtime] of folders)
    await fs.utimes(path, new Date(mtime), new Date(mtime));
  // MCP results past the cut, read from the server on first read
  job.kept.forEach((path, index) => {
    fs.writeFileLazy(path, async () => {
      const data = await ask(id, running, { type: "kept", index });
      return (data as string | Uint8Array | null) ?? "";
    });
  });
  const cwd = await savedCwd(fs, job.cwd, job.docs);
  // a cwd in the docs while they are off moves without a word
  let notice =
    cwd !== job.cwd && (job.docs || !underKnowledge(job.cwd))
      ? `started in ${cwd}: ${job.cwd} no longer exists\n`
      : "";
  post({ type: "phase", id, phase: "run", notice });
  const opened: OpenedRecord[] = [];
  const bash = new Bash({
    fs,
    cwd,
    commands: [...KNOWLEDGE_COMMANDS],
    customCommands: [
      makeOpenCommand(
        {
          knowledgeFileBytes: job.knowledgeFileBytes,
          visuals: job.visuals,
          knowledge: job.docs,
        },
        opened,
      ),
    ],
    defenseInDepth: true,
    ...(job.network ? { fetch: workerFetch(id, running) } : {}),
    executionLimits: executionLimits(job, fs, job.endsAt - Date.now()),
  });
  const result = await bash.exec(job.command, { rawScript: true, signal });
  const stdout = decodeBytesToUtf8(stdoutAsBytes(result));
  signal.throwIfAborted();
  notice = (await notices(fs, job)) + notice;
  // a diff that throws still opens its result with every notice
  post({ type: "phase", id, phase: "diff", notice });
  const printed = {
    stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    notice,
    opened,
  };
  if (result.exitCode === 124 || result.exitCode === 126)
    return { ...printed, changes: null };
  const changes = await diff(fs, job);
  const after = await savedCwd(fs, result.env.PWD, job.docs);
  return {
    ...printed,
    changes: {
      ...changes,
      // a cwd in the docs waits in /tmp until they are on again, unless
      // the command moved
      cwd:
        !job.docs && underKnowledge(job.cwd) && after === cwd ? job.cwd : after,
    },
  };
}

async function start(id: string, job: Job): Promise<void> {
  if (jobs.has(id)) return;
  const running: Running = {
    controller: new AbortController(),
    waiting: new Map(),
    next: 0,
  };
  jobs.set(id, running);
  try {
    const done = await run(id, job, running);
    const bytes = done.changes?.written.map((file) => file.data) ?? [];
    post({ type: "done", id, answer: done }, transferOf(bytes));
  } catch (error) {
    post({
      type: "failed",
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    jobs.delete(id);
  }
}

function cancel(id: string): void {
  const running = jobs.get(id);
  if (running === undefined) return;
  running.controller.abort(new Error("cancelled"));
  for (const waiting of running.waiting.values())
    waiting.reject(new Error("The operation was aborted."));
  running.waiting.clear();
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "job":
      void start(message.id, message.job);
      return;
    case "cancel":
      cancel(message.id);
      return;
    case "kept":
      answer(message.id, message.request, message.data);
      return;
    case "fetched":
      if (message.result !== undefined) {
        answer(message.id, message.request, message.result);
      } else {
        const error = new Error(message.error?.message ?? "fetch failed");
        error.name = message.error?.name ?? "Error";
        answer(message.id, message.request, undefined, error);
      }
      return;
  }
};
