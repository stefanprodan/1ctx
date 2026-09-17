// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { MAX_TITLE } from "../../shared/words.ts";

type Frame = {
  kind: "object" | "array";
  state: "first" | "key" | "colon" | "value" | "comma";
  key?: string;
};
type StringRole = "key" | "html" | "title" | "skip";
type NumberState =
  | "sign"
  | "zero"
  | "integer"
  | "dot"
  | "fraction"
  | "exponent"
  | "exponentSign"
  | "exponentDigits";

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const whitespace = (c: string) =>
  c === " " || c === "\t" || c === "\r" || c === "\n";
const digit = (c: string) => c >= "0" && c <= "9";

export class VisualStream {
  private readonly stack: Frame[] = [];
  private htmlValue = "";
  private titleValue: string | undefined;
  private stopped = false;
  private closed = false;
  private visited = 0;
  private started = false;
  private seenHtml = false;
  private bytes = 0;
  private mode: "structure" | "string" | "literal" | "number" = "structure";
  private role: StringRole = "skip";
  private captured: string | undefined;
  private escaped = false;
  private unicodeLeft = 0;
  private unicodeValue = 0;
  private high = "";
  private literal = "";
  private literalAt = 0;
  private number: NumberState = "zero";

  constructor(private readonly maxBytes: number) {}

  get html(): string {
    return this.htmlValue;
  }

  get title(): string | undefined {
    return this.titleValue;
  }

  get ended(): boolean {
    return this.stopped;
  }

  get complete(): boolean {
    return this.closed;
  }

  get scanned(): number {
    return this.visited;
  }

  push(delta: string): void {
    for (let i = 0; i < delta.length && !this.stopped; i++) {
      const c = delta[i] as string;
      this.visited++;
      if (this.mode === "string") this.string(c);
      else if (this.mode === "literal") this.readLiteral(c);
      else if (this.mode !== "number" || !this.readNumber(c)) {
        this.structure(c);
      }
    }
  }

  private structure(c: string): void {
    if (whitespace(c)) return;
    if (!this.started) {
      this.started = true;
      if (c === "{") this.open("object");
      else this.stopped = true;
      return;
    }
    const frame = this.stack.at(-1);
    if (!frame) {
      this.stopped = true;
      return;
    }
    if (frame.state === "comma") {
      if (c === ",") {
        frame.state = frame.kind === "object" ? "key" : "value";
      } else if (c === (frame.kind === "object" ? "}" : "]")) {
        this.close();
      } else this.stopped = true;
    } else if (frame.state === "colon") {
      if (c === ":") frame.state = "value";
      else this.stopped = true;
    } else if (
      frame.kind === "object" &&
      (frame.state === "first" || frame.state === "key")
    ) {
      if (c === '"') this.startString("key");
      else if (c === "}" && frame.state === "first") this.close();
      else this.stopped = true;
    } else if (frame.state === "first" && c === "]") {
      this.close();
    } else {
      this.value(c, frame);
    }
  }

  private value(c: string, frame: Frame): void {
    const root = this.stack.length === 1;
    const role =
      root && (frame.key === "html" || frame.key === "title")
        ? frame.key
        : "skip";
    frame.state = "comma";
    if (c === '"') this.startString(role);
    else if (c === "{") this.open("object");
    else if (c === "[") this.open("array");
    else if (c === "t" || c === "f" || c === "n") {
      this.mode = "literal";
      this.literal = c === "t" ? "true" : c === "f" ? "false" : "null";
      this.literalAt = 1;
    } else if (c === "-" || digit(c)) {
      this.mode = "number";
      this.number = c === "-" ? "sign" : c === "0" ? "zero" : "integer";
    } else this.stopped = true;
  }

  private open(kind: Frame["kind"]): void {
    this.stack.push({ kind, state: "first" });
  }

  private close(): void {
    this.stack.pop();
    if (this.stack.length === 0) this.closed = true;
  }

  private startString(role: StringRole): void {
    this.mode = "string";
    this.role = role;
    this.captured =
      role === "title" || (role === "key" && this.stack.length === 1)
        ? ""
        : undefined;
    this.escaped = false;
    this.unicodeLeft = 0;
    this.high = "";
  }

  private string(c: string): void {
    if (this.unicodeLeft > 0) {
      if (!/^[0-9a-fA-F]$/.test(c)) {
        this.stopped = true;
        return;
      }
      this.unicodeValue = this.unicodeValue * 16 + Number.parseInt(c, 16);
      if (--this.unicodeLeft === 0) {
        this.decoded(String.fromCharCode(this.unicodeValue));
      }
    } else if (this.escaped) {
      this.escaped = false;
      if (c === "u") {
        this.unicodeLeft = 4;
        this.unicodeValue = 0;
      } else {
        const decoded = ESCAPES[c];
        if (decoded === undefined) this.stopped = true;
        else this.decoded(decoded);
      }
    } else if (c === "\\") {
      this.escaped = true;
    } else if (c === '"') {
      this.endString();
    } else if (c.charCodeAt(0) < 0x20) {
      this.stopped = true;
    } else this.decoded(c);
  }

  private decoded(c: string): void {
    if (this.role !== "html") {
      if (this.captured !== undefined) {
        const cap = this.role === "key" ? 5 : MAX_TITLE;
        this.captured =
          this.captured.length < cap ? this.captured + c : undefined;
      }
      return;
    }
    const code = c.charCodeAt(0);
    if (this.high) {
      const high = this.high;
      this.high = "";
      if (code >= 0xdc00 && code <= 0xdfff) {
        this.append(high + c, 4);
        return;
      }
      this.append(high, 3);
      if (this.stopped) return;
    }
    // A later raw or escaped low surrogate may still complete this pair.
    if (code >= 0xd800 && code <= 0xdbff) this.high = c;
    else this.append(c, code < 0x80 ? 1 : code < 0x800 ? 2 : 3);
  }

  private append(text: string, bytes: number): void {
    if (this.bytes + bytes > this.maxBytes) {
      this.stopped = true;
      return;
    }
    this.htmlValue += text;
    this.bytes += bytes;
  }

  private endString(): void {
    if (this.high) {
      this.append(this.high, 3);
      this.high = "";
      if (this.stopped) return;
    }
    this.mode = "structure";
    if (this.role === "key") {
      const frame = this.stack.at(-1) as Frame;
      frame.key = this.captured;
      frame.state = "colon";
      if (this.stack.length === 1 && frame.key === "html") {
        // Already delivered text cannot be replaced by the duplicate value.
        if (this.seenHtml) this.stopped = true;
        this.seenHtml = true;
      }
    } else if (this.role === "title") {
      this.titleValue = this.captured;
    }
    this.captured = undefined;
  }

  private readLiteral(c: string): void {
    if (c !== this.literal[this.literalAt++]) this.stopped = true;
    else if (this.literalAt === this.literal.length) this.mode = "structure";
  }

  private readNumber(c: string): boolean {
    let next: NumberState | undefined;
    switch (this.number) {
      case "sign":
        if (digit(c)) next = c === "0" ? "zero" : "integer";
        break;
      case "zero":
      case "integer":
        if (this.number === "integer" && digit(c)) next = "integer";
        else if (c === ".") next = "dot";
        else if (c === "e" || c === "E") next = "exponent";
        break;
      case "dot":
        if (digit(c)) next = "fraction";
        break;
      case "fraction":
        if (digit(c)) next = "fraction";
        else if (c === "e" || c === "E") next = "exponent";
        break;
      case "exponent":
        if (c === "+" || c === "-") next = "exponentSign";
        else if (digit(c)) next = "exponentDigits";
        break;
      case "exponentSign":
      case "exponentDigits":
        if (digit(c)) next = "exponentDigits";
        break;
    }
    if (next !== undefined) {
      this.number = next;
      return true;
    }
    if (
      this.number === "sign" ||
      this.number === "dot" ||
      this.number === "exponent" ||
      this.number === "exponentSign"
    ) {
      this.stopped = true;
      return true;
    }
    this.mode = "structure";
    return false;
  }
}
