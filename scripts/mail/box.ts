// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The catcher's mailbox: one file per message and recipient, named
// `<address>--<UTC time>-<count>.eml`, so a recipient's newest is the
// last of its names in order. The folder is the owner's alone.

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Received } from "./smtp.ts";

const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+$/;

// an envelope recipient, `<a@b>` as RCPT gives it, or null when it
// would not make a safe file name
export function addressOf(value: string): string | null {
  const bare = value
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .toLowerCase();
  return ADDRESS.test(bare) && !bare.includes("..") ? bare : null;
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:.]/g, "");

export function openBox(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  let count = 0;
  return {
    // the paths written, one per recipient it could name
    write(message: Received, now = Date.now()): string[] {
      // a line the client began with a dot had it doubled
      const data = message.data
        .split("\r\n")
        .map((line) => (line.startsWith("..") ? line.slice(1) : line))
        .join("\r\n");
      count++;
      const written: string[] = [];
      for (const to of message.to) {
        const address = addressOf(to);
        if (address === null) continue;
        const path = join(
          dir,
          `${address}--${stamp(now)}-${String(count).padStart(6, "0")}.eml`,
        );
        writeFileSync(path, `${data}\r\n`, { mode: 0o600 });
        written.push(path);
      }
      return written;
    },
  };
}

export function newest(dir: string, address: string): string | null {
  const prefix = `${address.toLowerCase()}--`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const mine = names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".eml"))
    .sort();
  const last = mine.at(-1);
  return last === undefined ? null : join(dir, last);
}

type Part = { headers: Map<string, string>; body: string };

function split(raw: string): Part {
  const text = raw.replace(/\r\n/g, "\n");
  const end = text.indexOf("\n\n");
  const head = end === -1 ? text : text.slice(0, end);
  const body = end === -1 ? "" : text.slice(end + 2);
  const headers = new Map<string, string>();
  let last = "";
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && last !== "") {
      headers.set(last, `${headers.get(last)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    last = line.slice(0, colon).trim().toLowerCase();
    headers.set(last, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function quotedPrintable(text: string): Buffer {
  const soft = text.replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const hex = soft.slice(i + 1, i + 3);
    if (soft[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(soft[i]!, "utf8"));
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(part: Part): string {
  const encoding = (
    part.headers.get("content-transfer-encoding") ?? ""
  ).toLowerCase();
  if (encoding === "base64") {
    return Buffer.from(part.body.replace(/\s+/g, ""), "base64").toString(
      "utf8",
    );
  }
  if (encoding === "quoted-printable") {
    return quotedPrintable(part.body).toString("utf8");
  }
  return part.body;
}

// RFC 2047 words, as nodemailer writes a subject that is not ASCII
function decodeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=\s*/g,
    (_m, _charset: string, kind: string, text: string) =>
      kind.toLowerCase() === "b"
        ? Buffer.from(text, "base64").toString("utf8")
        : quotedPrintable(text.replace(/_/g, " ")).toString("utf8"),
  );
}

// the first text/plain part, through any multipart
function plainText(part: Part): string | null {
  const type = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = /boundary="?([^";]+)"?/i.exec(
      part.headers.get("content-type") ?? "",
    )?.[1];
    if (boundary === undefined) return null;
    for (const chunk of part.body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith("--")) break;
      const found = plainText(split(chunk.replace(/^\n/, "")));
      if (found !== null) return found;
    }
    return null;
  }
  return type.startsWith("text/plain") ? decodeBody(part) : null;
}

const LINK = /https?:\/\/[^\s<>()"]+/;
const LINK_ALL = new RegExp(LINK.source, "g");

export type Shown = {
  to: string;
  subject: string;
  date: string;
  text: string;
  code: string | null;
  link: string | null;
};

export function show(raw: string): Shown {
  const top = split(raw);
  const text = (plainText(top) ?? "").trim();
  return {
    to: decodeWords(top.headers.get("to") ?? ""),
    subject: decodeWords(top.headers.get("subject") ?? ""),
    date: top.headers.get("date") ?? "",
    text,
    // outside a link, whose token may hold six digits
    code: /\b(\d{6})\b/.exec(text.replace(LINK_ALL, " "))?.[1] ?? null,
    link: LINK.exec(text)?.[0] ?? null,
  };
}

export function showFile(path: string): Shown {
  return show(readFileSync(path, "utf8"));
}
