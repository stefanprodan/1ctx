// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The messages between the server's thread and a command worker. Every
// file's bytes are transferred, never cloned, so a post costs the
// server's thread next to nothing whatever the mount holds. The worker
// runs untrusted commands and postMessage is not blocked inside them, so
// the server takes a message only after checking its whole shape.

import type { FetchResult } from "just-bash";
import { isKnowledgeName, OPENED_KINDS } from "../../shared/words.ts";
import type { OpenedRecord } from "./open.ts";

// where a failed command ended, and why, as the tool log counts them
export type CommandPhase = "queue" | "mount" | "run" | "diff" | "commit";
export type CommandCause = "deadline" | "abort" | "limit" | "error";
export type CommandEnd = { phase: CommandPhase; cause: CommandCause };

// mtime is the stored time of the file's last change, in ms
export type MountFile = { name: string; data: Uint8Array; mtime: number };
export type ScratchEntry = { path: string; data: Uint8Array; mode: number };

export type Job = {
  command: string;
  // Date.now() at which the call's budget runs out
  endsAt: number;
  docs: boolean;
  visuals: boolean;
  network: boolean;
  // the saved cwd, checked against the mounted tree
  cwd: string;
  knowledgeFileBytes: number;
  mountBytes: number;
  ioBytes: number;
  // the cap on commands and on each loop, awk, sed and jq iteration
  iterations: number;
  knowledge: MountFile[];
  scratch: (MountFile & { mode: number })[];
  uploads: MountFile[];
  // the kept MCP files' paths; a read names its index
  kept: string[];
};

export type Changes = {
  knowledge: { name: string; text: string | null }[];
  written: ScratchEntry[];
  removed: string[];
  cwd: string;
};

export type Answer = {
  stdout: string;
  stderr: string;
  exitCode: number;
  notice: string;
  opened: OpenedRecord[];
  // null for an exit at a deadline or limit: nothing is read back
  changes: Changes | null;
};

// what curl asked for, headers as pairs since Headers do not clone
export type FetchRequest = {
  method?: string;
  headers?: [string, string][];
  body?: string;
  followRedirects?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
};

export type ToWorker =
  | { type: "job"; id: string; job: Job }
  | { type: "cancel"; id: string }
  | {
      type: "kept";
      id: string;
      request: number;
      // the bytes, or why the read failed, which the command sees
      data?: Uint8Array;
      error?: string;
    }
  | {
      type: "fetched";
      id: string;
      request: number;
      result?: FetchResult;
      error?: { name: string; message: string };
    };

export type FromWorker =
  | { type: "phase"; id: string; phase: "run" | "diff"; notice: string }
  | { type: "kept"; id: string; request: number; index: number }
  | {
      type: "fetch";
      id: string;
      request: number;
      url: string;
      options: FetchRequest;
    }
  // curl gave up on a fetch it asked for, as timeout does
  | { type: "abort"; id: string; request: number }
  | { type: "done"; id: string; answer: Answer }
  | { type: "failed"; id: string; message: string };

type Shape = Record<string, unknown>;

const isObject = (value: unknown): value is Shape =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isOptional = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || check(value);
const isBytes = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array;
function isList<T>(
  value: unknown,
  check: (item: unknown) => item is T,
): value is T[] {
  return Array.isArray(value) && value.every(check);
}
// exactly these keys, so nothing rides along unchecked
const keys = (value: Shape, names: readonly string[]) =>
  Object.keys(value).every((key) => names.includes(key));

function isOpened(value: unknown): value is OpenedRecord {
  return (
    isObject(value) &&
    keys(value, [
      "path",
      "kind",
      "language",
      "bytes",
      "lines",
      "title",
      "text",
    ]) &&
    isString(value.path) &&
    (OPENED_KINDS as readonly unknown[]).includes(value.kind) &&
    (value.language === null || isString(value.language)) &&
    isCount(value.bytes) &&
    isCount(value.lines) &&
    (value.title === null || isString(value.title)) &&
    isString(value.text)
  );
}

function isKnowledgeChange(
  value: unknown,
): value is Changes["knowledge"][number] {
  return (
    isObject(value) &&
    keys(value, ["name", "text"]) &&
    isKnowledgeName(value.name) &&
    (value.text === null || isString(value.text))
  );
}

function isScratchEntry(value: unknown): value is ScratchEntry {
  return (
    isObject(value) &&
    keys(value, ["path", "data", "mode"]) &&
    isKnowledgeName(value.path) &&
    isBytes(value.data) &&
    isCount(value.mode)
  );
}

function isChanges(value: unknown): value is Changes {
  return (
    isObject(value) &&
    keys(value, ["knowledge", "written", "removed", "cwd"]) &&
    isList(value.knowledge, isKnowledgeChange) &&
    isList(value.written, isScratchEntry) &&
    isList(value.removed, isKnowledgeName) &&
    isString(value.cwd)
  );
}

function isAnswer(value: unknown): value is Answer {
  return (
    isObject(value) &&
    keys(value, [
      "stdout",
      "stderr",
      "exitCode",
      "notice",
      "opened",
      "changes",
    ]) &&
    isString(value.stdout) &&
    isString(value.stderr) &&
    isInt(value.exitCode) &&
    isString(value.notice) &&
    isList(value.opened, isOpened) &&
    (value.changes === null || isChanges(value.changes))
  );
}

function isHeader(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isString(value[0]) &&
    isString(value[1])
  );
}

function isFetchRequest(value: unknown): value is FetchRequest {
  return (
    isObject(value) &&
    keys(value, [
      "method",
      "headers",
      "body",
      "followRedirects",
      "timeoutMs",
      "maxRedirects",
    ]) &&
    isOptional(value.method, isString) &&
    isOptional(value.headers, (headers) => isList(headers, isHeader)) &&
    isOptional(value.body, isString) &&
    isOptional(value.followRedirects, (flag) => typeof flag === "boolean") &&
    isOptional(value.timeoutMs, isCount) &&
    isOptional(value.maxRedirects, isCount)
  );
}

export const MALFORMED = "malformed";

// the message for this job, MALFORMED for an answer of this job that
// does not check out, or null for anything else: another id, an unknown
// type, a field missing, extra or of the wrong kind
export function fromWorker(
  value: unknown,
  id: string,
): FromWorker | typeof MALFORMED | null {
  if (!isObject(value) || value.id !== id) return null;
  switch (value.type) {
    case "phase":
      return keys(value, ["type", "id", "phase", "notice"]) &&
        (value.phase === "run" || value.phase === "diff") &&
        isString(value.notice)
        ? (value as FromWorker)
        : null;
    case "kept":
      return keys(value, ["type", "id", "request", "index"]) &&
        isCount(value.request) &&
        isCount(value.index)
        ? (value as FromWorker)
        : null;
    case "abort":
      return keys(value, ["type", "id", "request"]) && isCount(value.request)
        ? (value as FromWorker)
        : null;
    case "fetch":
      return keys(value, ["type", "id", "request", "url", "options"]) &&
        isCount(value.request) &&
        isString(value.url) &&
        isFetchRequest(value.options)
        ? (value as FromWorker)
        : null;
    // an end of this job that does not check out ends it all the same,
    // rather than leaving it to the deadline
    case "done":
      return keys(value, ["type", "id", "answer"]) && isAnswer(value.answer)
        ? (value as FromWorker)
        : MALFORMED;
    case "failed":
      return keys(value, ["type", "id", "message"]) && isString(value.message)
        ? (value as FromWorker)
        : MALFORMED;
    default:
      return null;
  }
}

// a buffer that can be transferred whole: a view of a larger or pooled
// buffer is copied first, so a transfer never detaches another view's
// bytes
export function owned(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    !Buffer.isBuffer(bytes) &&
    bytes.buffer instanceof ArrayBuffer
    ? bytes
    : new Uint8Array(bytes);
}

// the transfer list of a message's byte arrays, each buffer once
export function transferOf(list: readonly Uint8Array[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const bytes of list) buffers.add(bytes.buffer as ArrayBuffer);
  return [...buffers];
}
