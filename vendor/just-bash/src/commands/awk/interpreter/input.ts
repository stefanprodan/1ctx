/**
 * (1ctx) AWK input: the main input walk over ARGV and the record streams.
 *
 * As gawk does, the operands are read from ARGV[1] to ARGV[ARGC-1] as they
 * stand when the walk reaches them, so BEGIN may delete, rewrite or add
 * entries; a `name=value` entry is an assignment done at that point, `-`
 * is stdin, and with no file operand the input is stdin.
 */

import { ExecutionLimitError } from "../../../interpreter/errors.js";
import { utf8ByteLength } from "../../printf/escapes.js";
import { isReservedName, operandAssignment } from "../options.js";
import type { AwkRuntimeContext } from "./context.js";
import { nextRecord } from "./records.js";
import { toNumber } from "./type-coercion.js";
import { setVariable } from "./variables.js";

export interface InputStream {
  text: string;
  pos: number;
  count: number;
}

/** Opens a stream over text, charging it to the command's input budget. */
export function openStream(ctx: AwkRuntimeContext, text: string): InputStream {
  chargeInput(ctx, utf8ByteLength(text));
  return { text, pos: 0, count: 0 };
}

/** Fails when bytes more would pass the input budget every stream shares. */
export function chargeInput(ctx: AwkRuntimeContext, bytes: number): void {
  if (bytes > ctx.maxInputBytes - ctx.inputBytes) {
    throw new ExecutionLimitError(
      `aggregate input size limit exceeded (${ctx.maxInputBytes} bytes)`,
      "string_length",
    );
  }
  ctx.inputBytes += bytes;
}

/** The next record of a stream under the current RS, setting RT, or null. */
export function readRecord(
  ctx: AwkRuntimeContext,
  stream: InputStream,
): string | null {
  const next = nextRecord(stream.text, stream.pos, ctx.RS, ctx.signal);
  if (!next) return null;
  stream.pos = next.next;
  countRecord(ctx, stream);
  ctx.RT = next.rt;
  return next.record;
}

function countRecord(ctx: AwkRuntimeContext, stream: InputStream): void {
  stream.count++;
  if (stream.count > ctx.maxArrayElements) {
    throw new ExecutionLimitError(
      `record array limit exceeded (${ctx.maxArrayElements})`,
      "array_elements",
    );
  }
}

export interface MainInputIO {
  /** The text of an operand file; throws when it cannot be read. */
  readFile(name: string): Promise<string>;
  /** Standard input, once; empty after the first read. */
  readStdin(): string;
}

export class MainInput {
  private index = 1;
  private sawFile = false;
  private done = false;
  private stream: InputStream | null = null;

  constructor(
    private readonly ctx: AwkRuntimeContext,
    private readonly io: MainInputIO,
  ) {}

  /** The next record of the main input, or null once every operand is read. */
  async nextRecord(): Promise<string | null> {
    for (;;) {
      if (this.stream) {
        const record = readRecord(this.ctx, this.stream);
        if (record !== null) return record;
        this.stream = null;
      }
      if (!(await this.openNext())) return null;
    }
  }

  /** Leaves the current file, for nextfile. */
  skipFile(): void {
    this.stream = null;
  }

  private async openNext(): Promise<boolean> {
    const ctx = this.ctx;
    while (!this.done) {
      if (this.index >= toNumber(ctx.ARGC)) {
        this.done = true;
        if (this.sawFile) return false;
        this.sawFile = true;
        this.open("-", this.io.readStdin());
        return true;
      }
      const arg = ctx.ARGV[String(this.index++)];
      if (arg === undefined || arg === "") continue;
      const assignment = operandAssignment(arg);
      if (assignment) {
        assignOperand(ctx, assignment.name, assignment.value);
        continue;
      }
      this.sawFile = true;
      if (arg === "-") {
        this.open("-", this.io.readStdin());
      } else {
        this.open(arg, await this.io.readFile(arg));
      }
      return true;
    }
    return false;
  }

  private open(name: string, text: string): void {
    this.stream = openStream(this.ctx, text);
    this.ctx.FILENAME = name;
    this.ctx.FNR = 0;
  }
}

function assignOperand(
  ctx: AwkRuntimeContext,
  name: string,
  value: string,
): void {
  if (isReservedName(name)) {
    throw new Error(`cannot use gawk builtin '${name}' as variable name`);
  }
  if (ctx.arrays[name] !== undefined) {
    throw new Error(`attempt to use array '${name}' in a scalar context`);
  }
  setVariable(ctx, name, value);
}
