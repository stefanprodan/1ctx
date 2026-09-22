// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One slog-text line per event on stderr. The time is the log's own,
// not the clock port's: a service manager's log file carries no time,
// and a test passes `silent`.

export type LogValue = string | number | boolean | undefined;

export type LogFields = Record<string, LogValue> & {
  time?: never;
  level?: never;
  msg?: never;
  area?: never;
  duration?: number;
};

export type LogLevel = "info" | "warn" | "error";
export type LogMethod = (msg: string, fields?: LogFields) => void;
export type Log = Record<LogLevel, LogMethod>;
export type LogFactory = (area: string) => Log;

const RESERVED = new Set(["time", "level", "msg", "area"]);
const KEY = /^[a-z][a-z0-9_]*$/;
const ERROR_RUNES = 200;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
const ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "HttpError",
  "BadRequest",
  "Unauthorized",
  "Forbidden",
  "NotFound",
  "TooManyRequests",
  "PayloadTooLarge",
  "Conflict",
  "BadGateway",
  "ServiceUnavailable",
  "ProviderError",
  "CatalogError",
  "ServiceError",
]);
const NON_PRINTABLE = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;

function needsQuote(value: string): boolean {
  if (value === "") return true;
  for (const rune of value) {
    const code = rune.codePointAt(0)!;
    if (code <= 0x20 || rune === "=" || rune === '"') return true;
    if (code > 0x7f && NON_PRINTABLE.test(rune)) return true;
  }
  return false;
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, "0");
}

function invalidUtf8(code: number): string {
  if (code <= 0xdbff) {
    return [0xed, 0xa0 | ((code - 0xd800) >> 6), 0x80 | (code & 0x3f)]
      .map((byte) => `\\x${hex(byte, 2)}`)
      .join("");
  }
  return [0xed, 0xb0 | ((code - 0xdc00) >> 6), 0x80 | (code & 0x3f)]
    .map((byte) => `\\x${hex(byte, 2)}`)
    .join("");
}

function quote(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const rune = value.slice(i, i + 2);
        const point = rune.codePointAt(0)!;
        out += NON_PRINTABLE.test(rune) ? `\\U${hex(point, 8)}` : rune;
        i++;
      } else {
        out += invalidUtf8(code);
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += invalidUtf8(code);
      continue;
    }
    const escapes: Record<number, string> = {
      7: "\\a",
      8: "\\b",
      9: "\\t",
      10: "\\n",
      11: "\\v",
      12: "\\f",
      13: "\\r",
    };
    if (escapes[code] !== undefined) out += escapes[code];
    else if (code === 0x22 || code === 0x5c) out += `\\${value[i]}`;
    else if (code < 0x20 || code === 0x7f) out += `\\x${hex(code, 2)}`;
    else {
      const rune = value[i]!;
      out +=
        code > 0x7f && NON_PRINTABLE.test(rune) ? `\\u${hex(code, 4)}` : rune;
    }
  }
  return `${out}"`;
}

function stringValue(value: string): string {
  return needsQuote(value) ? quote(value) : value;
}

function numberValue(value: number): string {
  if (Object.is(value, -0)) return "-0";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1e6 || absolute < 1e-4)) {
    return value.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  }
  return String(value);
}

// the error is cut here, after the scrubber saw it whole: a key cut in
// half before scrubbing would leave its first half on the line
function cut(value: string): string {
  const runes = [...value];
  return runes.length <= ERROR_RUNES
    ? value
    : `${runes.slice(0, ERROR_RUNES - 3).join("")}...`;
}

export function format(
  at: Date,
  area: string,
  level: LogLevel,
  msg: string,
  fields: LogFields = {},
): string {
  const parts = [
    `time=${at.toISOString()}`,
    `level=${level.toUpperCase()}`,
    `msg=${stringValue(msg)}`,
    `area=${stringValue(area)}`,
  ];
  let bad = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!KEY.test(key) || RESERVED.has(key)) {
      bad++;
      continue;
    }
    if (key === "duration" && typeof value !== "number") {
      bad++;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        bad++;
        continue;
      }
      parts.push(
        `${key}=${
          key === "duration" ? `${Math.round(value)}ms` : numberValue(value)
        }`,
      );
      continue;
    }
    if (typeof value === "string") {
      parts.push(`${key}=${stringValue(key === "error" ? cut(value) : value)}`);
      continue;
    }
    if (typeof value === "boolean") {
      parts.push(`${key}=${value}`);
      continue;
    }
    bad++;
  }
  if (bad > 0) parts.push(`bad_fields=${bad}`);
  return parts.join(" ");
}

export function logger(area: string): Log {
  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    console.error(format(new Date(), area, level, msg, fields));
  };
  return {
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}

export const silent: Log = {
  info() {},
  warn() {},
  error() {},
};

export function scrubErrors(log: Log, values: () => string[]): Log {
  const scrub = (fields?: LogFields): LogFields | undefined => {
    if (typeof fields?.error !== "string") return fields;
    let error = fields.error;
    for (const value of values().sort((a, b) => b.length - a.length)) {
      if (value !== "") error = error.replaceAll(value, "[key]");
    }
    return { ...fields, error: cut(error) };
  };
  const write = (level: LogLevel) => (msg: string, fields?: LogFields) =>
    log[level](msg, scrub(fields));
  return {
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

function cleanUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      url.search = "";
      return url.toString();
    } catch {
      return raw;
    }
  });
}

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

function firstLine(message: string): string {
  return cleanUrls(message.split(LINE_BREAK, 1)[0] ?? "");
}

function errorType(error: unknown): string {
  if (!(error instanceof Error)) return "exception";
  const constructorName = error.constructor.name;
  const name = error.name === "Error" ? constructorName : error.name;
  return ERROR_NAMES.has(name) ? name : "exception";
}

function sourceStack(error: Error): string | undefined {
  const frames: string[] = [];
  // the message heads the stack and may span lines; frames follow it
  const skip = error.message.split("\n").length;
  for (const line of error.stack?.split("\n").slice(skip) ?? []) {
    // absolute under `bun test`, relative in a binary built with
    // --sourcemap, which is the only way a binary names its sources
    const found = line.match(
      /(?:\(|\s)(?:file:\/\/)?([^\s()]*src\/[^\s():]+):(\d+):\d+/,
    );
    if (found === null) continue;
    const path = `/${found[1]!}`;
    const server = path.lastIndexOf("/src/server/");
    const source = path.lastIndexOf("/src/");
    if (server >= 0) frames.push(`${path.slice(server + 12)}:${found[2]}`);
    else if (source >= 0) frames.push(`${path.slice(source + 5)}:${found[2]}`);
    if (frames.length === 5) break;
  }
  return frames.length > 0 ? frames.join(" ") : undefined;
}

export function errorFields(error: unknown, stack = true): LogFields {
  const fields: LogFields = { error_type: errorType(error) };
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : undefined;
  if (message) fields.error = firstLine(message);
  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;
    if (typeof value.code === "string" && ERROR_CODE.test(value.code)) {
      fields.error_code = value.code;
    }
    if (typeof value.status === "number" && Number.isFinite(value.status)) {
      fields.status = value.status;
    }
    if (typeof value.retry === "boolean") fields.retry = value.retry;
  }
  if (stack && error instanceof Error) fields.stack = sourceStack(error);
  return fields;
}
