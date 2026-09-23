/**
 * AWK Expression Evaluation
 *
 * Async expression evaluator supporting file I/O operations.
 */

import { decodeBytesToUtf8, unsafeBytesFromLatin1 } from "../../../encoding.js";
import { rethrowFatalExecutionError } from "../../../fatal-execution-error.js";
import { ExecutionLimitError } from "../../../interpreter/errors.js";
import { createUserRegex } from "../../../regex/index.js";
import {
  assertDefenseContext,
  awaitWithDefenseContext,
} from "../../../security/defense-context.js";
import { SecurityViolationError } from "../../../security/defense-in-depth-box.js";
import { applyNumericBinaryOp } from "../../../shared/operators.js";
import type {
  AwkArrayAccess,
  AwkExpr,
  AwkFieldRef,
  AwkFunctionDef,
  AwkVariable,
} from "../ast.js";
import { awkBuiltins } from "../builtins.js";
import type { AwkRuntimeContext } from "./context.js";
import { getField, setCurrentLine, setField } from "./fields.js";
import { openStream, readRecord } from "./input.js";
import {
  isTruthy,
  looksLikeNumber,
  matchRegex,
  toStr,
  toNumber,
} from "./type-coercion.js";
import type { AwkValue } from "./types.js";
import {
  getArrayElement,
  getVariable,
  hasArrayElement,
  isArrayName,
  readArrayElement,
  resolveArrayName,
  deleteArray,
  setArrayElement,
  setVariable,
} from "./variables.js";

// Forward declaration for statement executor (needed for user functions)
export type BlockExecutor = (
  ctx: AwkRuntimeContext,
  statements: import("../ast.js").AwkStmt[],
) => Promise<void>;

let executeBlockFn: BlockExecutor | null = null;

/**
 * Set the block executor function (called from statements.ts to avoid circular deps)
 */
export function setBlockExecutor(fn: BlockExecutor): void {
  executeBlockFn = fn;
}

function assertAwkDefenseContext(ctx: AwkRuntimeContext, phase: string): void {
  assertDefenseContext(ctx.requireDefenseContext, "awk", phase);
}

function withDefenseContext<T>(
  ctx: AwkRuntimeContext,
  phase: string,
  op: () => Promise<T>,
): Promise<T> {
  return awaitWithDefenseContext(ctx.requireDefenseContext, "awk", phase, op);
}

/**
 * Evaluate an AWK expression asynchronously.
 */
export async function evalExpr(
  ctx: AwkRuntimeContext,
  expr: AwkExpr,
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "expression evaluation");
  ctx.coverage?.hit(`awk:expr:${expr.type}`);
  switch (expr.type) {
    case "number":
      return expr.value;

    case "string":
      return expr.value;

    case "regex":
      // Regex used as expression matches against $0
      return matchRegex(expr.pattern, ctx.line) ? 1 : 0;

    case "field":
      return evalFieldRef(ctx, expr);

    case "variable":
      return getVariable(ctx, expr.name);

    case "array_access":
      return evalArrayAccess(ctx, expr);

    case "binary":
      return evalBinaryOp(ctx, expr);

    case "unary":
      return evalUnaryOp(ctx, expr);

    case "ternary":
      return isTruthy(
        await withDefenseContext(ctx, "ternary condition evaluation", () =>
          evalExpr(ctx, expr.condition),
        ),
      )
        ? await withDefenseContext(ctx, "ternary consequent evaluation", () =>
            evalExpr(ctx, expr.consequent),
          )
        : await withDefenseContext(ctx, "ternary alternate evaluation", () =>
            evalExpr(ctx, expr.alternate),
          );

    case "call":
      return evalFunctionCall(ctx, expr.name, expr.args);

    case "assignment":
      return evalAssignment(ctx, expr);

    case "pre_increment":
      return evalPreIncrement(ctx, expr.operand);

    case "pre_decrement":
      return evalPreDecrement(ctx, expr.operand);

    case "post_increment":
      return evalPostIncrement(ctx, expr.operand);

    case "post_decrement":
      return evalPostDecrement(ctx, expr.operand);

    case "in":
      return evalInExpr(ctx, expr.key, expr.array);

    case "getline":
      return evalGetline(ctx, expr.variable, expr.file, expr.command);

    case "tuple":
      return evalTuple(ctx, expr.elements);

    default:
      return "";
  }
}

async function evalFieldRef(
  ctx: AwkRuntimeContext,
  expr: AwkFieldRef,
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "field reference evaluation");
  const index = Math.floor(
    toNumber(
      await withDefenseContext(ctx, "field index evaluation", () =>
        evalExpr(ctx, expr.index),
      ),
    ),
  );
  return getField(ctx, index);
}

async function evalArrayAccess(
  ctx: AwkRuntimeContext,
  expr: AwkArrayAccess,
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "array access evaluation");
  const key = toStr(ctx,
    await withDefenseContext(ctx, "array key evaluation", () =>
      evalExpr(ctx, expr.key),
    ),
  );
  // (1ctx) a reference creates the element, as in gawk
  return readArrayElement(ctx, expr.array, key);
}

async function evalBinaryOp(
  ctx: AwkRuntimeContext,
  expr: { operator: string; left: AwkExpr; right: AwkExpr },
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "binary expression evaluation");
  const op = expr.operator;

  // Short-circuit evaluation for logical operators
  if (op === "||") {
    return isTruthy(
      await withDefenseContext(ctx, "logical-or left evaluation", () =>
        evalExpr(ctx, expr.left),
      ),
    ) ||
      isTruthy(
        await withDefenseContext(ctx, "logical-or right evaluation", () =>
          evalExpr(ctx, expr.right),
        ),
      )
      ? 1
      : 0;
  }
  if (op === "&&") {
    return isTruthy(
      await withDefenseContext(ctx, "logical-and left evaluation", () =>
        evalExpr(ctx, expr.left),
      ),
    ) &&
      isTruthy(
        await withDefenseContext(ctx, "logical-and right evaluation", () =>
          evalExpr(ctx, expr.right),
        ),
      )
      ? 1
      : 0;
  }

  // Regex match operators - handle regex literal specially
  if (op === "~") {
    const left = await withDefenseContext(ctx, "regex left evaluation", () =>
      evalExpr(ctx, expr.left),
    );
    if (expr.right.type === "regex") ctx.coverage?.hit("awk:expr:regex");
    const pattern =
      expr.right.type === "regex"
        ? expr.right.pattern
        : toStr(ctx,
            await withDefenseContext(ctx, "regex right evaluation", () =>
              evalExpr(ctx, expr.right),
            ),
          );
    try {
      return createUserRegex(pattern).test(toStr(ctx, left)) ? 1 : 0;
    } catch {
      return 0;
    }
  }
  if (op === "!~") {
    const left = await withDefenseContext(
      ctx,
      "negated-regex left evaluation",
      () => evalExpr(ctx, expr.left),
    );
    if (expr.right.type === "regex") ctx.coverage?.hit("awk:expr:regex");
    const pattern =
      expr.right.type === "regex"
        ? expr.right.pattern
        : toStr(ctx,
            await withDefenseContext(
              ctx,
              "negated-regex right evaluation",
              () => evalExpr(ctx, expr.right),
            ),
          );
    try {
      return createUserRegex(pattern).test(toStr(ctx, left)) ? 0 : 1;
    } catch {
      return 1;
    }
  }

  const left = await withDefenseContext(ctx, "binary left evaluation", () =>
    evalExpr(ctx, expr.left),
  );
  const right = await withDefenseContext(ctx, "binary right evaluation", () =>
    evalExpr(ctx, expr.right),
  );

  // String concatenation
  if (op === " ") {
    const result = toStr(ctx, left) + toStr(ctx, right);
    if (ctx.maxOutputSize > 0 && result.length > ctx.maxOutputSize) {
      throw new ExecutionLimitError(
        `awk: string concatenation size limit exceeded (${ctx.maxOutputSize} bytes)`,
        "string_length",
        ctx.output,
      );
    }
    return result;
  }

  // Comparison operators
  if (isComparisonOp(op)) {
    // (1ctx) a string constant or a concatenation is a string, never a
    // number, so the comparison is of strings as in gawk
    const asStrings = isStringExpr(expr.left) || isStringExpr(expr.right);
    return evalComparison(ctx, left, right, op, asStrings);
  }

  // Arithmetic operators
  const leftNum = toNumber(left);
  const rightNum = toNumber(right);
  return applyNumericBinaryOp(leftNum, rightNum, op);
}

function isComparisonOp(op: string): boolean {
  return ["<", "<=", ">", ">=", "==", "!="].includes(op);
}

function isStringExpr(expr: AwkExpr): boolean {
  return (
    expr.type === "string" || (expr.type === "binary" && expr.operator === " ")
  );
}

function evalComparison(
  ctx: AwkRuntimeContext,
  left: AwkValue,
  right: AwkValue,
  op: string,
  asStrings: boolean,
): number {
  const leftIsNum = looksLikeNumber(left);
  const rightIsNum = looksLikeNumber(right);

  if (!asStrings && leftIsNum && rightIsNum) {
    const l = toNumber(left);
    const r = toNumber(right);
    switch (op) {
      case "<":
        return l < r ? 1 : 0;
      case "<=":
        return l <= r ? 1 : 0;
      case ">":
        return l > r ? 1 : 0;
      case ">=":
        return l >= r ? 1 : 0;
      case "==":
        return l === r ? 1 : 0;
      case "!=":
        return l !== r ? 1 : 0;
    }
  }

  const l = toStr(ctx, left);
  const r = toStr(ctx, right);
  switch (op) {
    case "<":
      return l < r ? 1 : 0;
    case "<=":
      return l <= r ? 1 : 0;
    case ">":
      return l > r ? 1 : 0;
    case ">=":
      return l >= r ? 1 : 0;
    case "==":
      return l === r ? 1 : 0;
    case "!=":
      return l !== r ? 1 : 0;
  }
  return 0;
}

async function evalUnaryOp(
  ctx: AwkRuntimeContext,
  expr: { operator: string; operand: AwkExpr },
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "unary expression evaluation");
  const val = await withDefenseContext(ctx, "unary operand evaluation", () =>
    evalExpr(ctx, expr.operand),
  );
  switch (expr.operator) {
    case "!":
      return isTruthy(val) ? 0 : 1;
    case "-":
      return -toNumber(val);
    case "+":
      return +toNumber(val);
    default:
      return val;
  }
}

async function evalFunctionCall(
  ctx: AwkRuntimeContext,
  name: string,
  args: AwkExpr[],
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "function call evaluation");
  // Check for built-in functions first
  const builtin = awkBuiltins.get(name);
  if (builtin) {
    // Built-ins use a wrapper that handles async
    return builtin(args, ctx, { evalExpr: (e: AwkExpr) => evalExpr(ctx, e) });
  }

  // Check for user-defined function
  const userFunc = ctx.functions.get(name);
  if (userFunc) {
    return callUserFunction(ctx, userFunc, args);
  }

  return "";
}

async function callUserFunction(
  ctx: AwkRuntimeContext,
  func: AwkFunctionDef,
  args: AwkExpr[],
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "user function call");
  // Check recursion depth limit
  ctx.currentRecursionDepth++;
  if (ctx.currentRecursionDepth > ctx.maxRecursionDepth) {
    ctx.currentRecursionDepth--;
    throw new ExecutionLimitError(
      `awk: recursion depth exceeded maximum (${ctx.maxRecursionDepth})`,
      "recursion",
      ctx.output,
    );
  }

  // (1ctx) Arguments are evaluated in the caller's scope before any is
  // bound. A variable is passed by reference, so an array stays shared and
  // an untyped variable can become one; a parameter without an argument is
  // untyped and may be a local array, which ends with the call.
  const bound: Array<{ alias?: string; value?: AwkValue }> = [];
  for (let i = 0; i < func.params.length; i++) {
    if (i >= args.length) {
      bound.push({});
      continue;
    }
    const arg = args[i];
    if (arg.type === "variable") {
      bound.push({
        alias: resolveArrayName(ctx, arg.name),
        value: isArrayName(ctx, arg.name)
          ? undefined
          : getVariable(ctx, arg.name),
      });
    } else {
      bound.push({
        value: await withDefenseContext(
          ctx,
          "user function argument evaluation",
          () => evalExpr(ctx, arg),
        ),
      });
    }
  }

  const saved = func.params.map((param) => ({
    value: ctx.vars[param],
    array: ctx.arrays[param],
    alias: ctx.arrayAliases.get(param),
  }));
  for (let i = 0; i < func.params.length; i++) {
    const param = func.params[i];
    const { alias, value } = bound[i];
    if (alias !== undefined && alias !== param) {
      ctx.arrayAliases.set(param, alias);
    } else {
      ctx.arrayAliases.delete(param);
    }
    if (value === undefined) delete ctx.vars[param];
    else ctx.vars[param] = value;
    if (alias === undefined) delete ctx.arrays[param];
  }

  // Execute function body
  ctx.hasReturn = false;
  ctx.returnValue = undefined;

  const blockExecutor = executeBlockFn;
  if (blockExecutor) {
    await withDefenseContext(ctx, "user function body execution", () =>
      blockExecutor(ctx, func.body.statements),
    );
  }

  const result = ctx.returnValue ?? "";

  for (let i = 0; i < func.params.length; i++) {
    const param = func.params[i];
    const before = saved[i];
    if (bound[i].alias === undefined) deleteArray(ctx, param);
    if (before.array !== undefined) ctx.arrays[param] = before.array;
    if (before.value !== undefined) ctx.vars[param] = before.value;
    else delete ctx.vars[param];
    if (before.alias !== undefined) ctx.arrayAliases.set(param, before.alias);
    else ctx.arrayAliases.delete(param);
  }

  ctx.hasReturn = false;
  ctx.returnValue = undefined;
  ctx.currentRecursionDepth--;

  return result;
}

async function evalAssignment(
  ctx: AwkRuntimeContext,
  expr: {
    operator: string;
    target: AwkFieldRef | AwkVariable | AwkArrayAccess;
    value: AwkExpr;
  },
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "assignment evaluation");
  const value = await withDefenseContext(
    ctx,
    "assignment value evaluation",
    () => evalExpr(ctx, expr.value),
  );
  const target = expr.target;
  const op = expr.operator;

  let finalValue: AwkValue;

  if (op === "=") {
    finalValue = value;
  } else {
    // Compound assignment - get current value
    let current: AwkValue;
    if (target.type === "field") {
      const index = Math.floor(
        toNumber(
          await withDefenseContext(ctx, "assignment field index", () =>
            evalExpr(ctx, target.index),
          ),
        ),
      );
      current = getField(ctx, index);
    } else if (target.type === "variable") {
      current = getVariable(ctx, target.name);
    } else {
      const key = toStr(ctx,
        await withDefenseContext(ctx, "assignment array key", () =>
          evalExpr(ctx, target.key),
        ),
      );
      current = getArrayElement(ctx, target.array, key);
    }

    const currentNum = toNumber(current);
    const valueNum = toNumber(value);

    switch (op) {
      case "+=":
        finalValue = currentNum + valueNum;
        break;
      case "-=":
        finalValue = currentNum - valueNum;
        break;
      case "*=":
        finalValue = currentNum * valueNum;
        break;
      case "/=":
        finalValue = valueNum !== 0 ? currentNum / valueNum : 0;
        break;
      case "%=":
        finalValue = valueNum !== 0 ? currentNum % valueNum : 0;
        break;
      case "^=":
        finalValue = currentNum ** valueNum;
        break;
      default:
        finalValue = value;
    }
  }

  // Assign to target
  if (target.type === "field") {
    const index = Math.floor(
      toNumber(
        await withDefenseContext(ctx, "assignment target field index", () =>
          evalExpr(ctx, target.index),
        ),
      ),
    );
    setField(ctx, index, finalValue);
  } else if (target.type === "variable") {
    setVariable(ctx, target.name, finalValue);
  } else {
    const key = toStr(ctx,
      await withDefenseContext(ctx, "assignment target array key", () =>
        evalExpr(ctx, target.key),
      ),
    );
    setArrayElement(ctx, target.array, key, finalValue);
  }

  return finalValue;
}

/**
 * Helper for increment/decrement operations.
 * Applies delta (+1 or -1) to the operand and returns either old or new value.
 */
async function applyIncDec(
  ctx: AwkRuntimeContext,
  operand: AwkVariable | AwkArrayAccess | AwkFieldRef,
  delta: 1 | -1,
  returnNew: boolean,
): Promise<number> {
  assertAwkDefenseContext(ctx, "inc/dec evaluation");
  let oldVal: number;

  if (operand.type === "field") {
    const index = Math.floor(
      toNumber(
        await withDefenseContext(ctx, "inc/dec field index", () =>
          evalExpr(ctx, operand.index),
        ),
      ),
    );
    oldVal = toNumber(getField(ctx, index));
    setField(ctx, index, oldVal + delta);
  } else if (operand.type === "variable") {
    oldVal = toNumber(getVariable(ctx, operand.name));
    setVariable(ctx, operand.name, oldVal + delta);
  } else {
    const key = toStr(ctx,
      await withDefenseContext(ctx, "inc/dec array key", () =>
        evalExpr(ctx, operand.key),
      ),
    );
    oldVal = toNumber(getArrayElement(ctx, operand.array, key));
    setArrayElement(ctx, operand.array, key, oldVal + delta);
  }

  return returnNew ? oldVal + delta : oldVal;
}

async function evalPreIncrement(
  ctx: AwkRuntimeContext,
  operand: AwkVariable | AwkArrayAccess | AwkFieldRef,
): Promise<AwkValue> {
  return applyIncDec(ctx, operand, 1, true);
}

async function evalPreDecrement(
  ctx: AwkRuntimeContext,
  operand: AwkVariable | AwkArrayAccess | AwkFieldRef,
): Promise<AwkValue> {
  return applyIncDec(ctx, operand, -1, true);
}

async function evalPostIncrement(
  ctx: AwkRuntimeContext,
  operand: AwkVariable | AwkArrayAccess | AwkFieldRef,
): Promise<AwkValue> {
  return applyIncDec(ctx, operand, 1, false);
}

async function evalPostDecrement(
  ctx: AwkRuntimeContext,
  operand: AwkVariable | AwkArrayAccess | AwkFieldRef,
): Promise<AwkValue> {
  return applyIncDec(ctx, operand, -1, false);
}

async function evalInExpr(
  ctx: AwkRuntimeContext,
  key: AwkExpr,
  array: string,
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "in-expression evaluation");
  let keyStr: string;
  if (key.type === "tuple") {
    ctx.coverage?.hit("awk:expr:tuple");
    // Multi-dimensional key: join with SUBSEP
    const parts: string[] = [];
    for (const e of key.elements) {
      parts.push(
        toStr(ctx,
          await withDefenseContext(ctx, "tuple key element evaluation", () =>
            evalExpr(ctx, e),
          ),
        ),
      );
    }
    keyStr = parts.join(ctx.SUBSEP);
  } else {
    keyStr = toStr(ctx,
      await withDefenseContext(ctx, "in-expression key evaluation", () =>
        evalExpr(ctx, key),
      ),
    );
  }
  return hasArrayElement(ctx, array, keyStr) ? 1 : 0;
}

/**
 * Evaluate getline - reads next line from current input, file, or command pipe.
 */
async function evalGetline(
  ctx: AwkRuntimeContext,
  variable?: string,
  file?: AwkExpr,
  command?: AwkExpr,
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "getline evaluation");
  // "cmd" | getline - read from command pipe
  if (command) {
    return evalGetlineFromCommand(ctx, variable, command);
  }

  // getline < "file" - read from external file
  if (file) {
    return evalGetlineFromFile(ctx, variable, file);
  }

  // (1ctx) plain getline reads the main input walk, in BEGIN too
  if (!ctx.mainInput) {
    return -1;
  }
  const nextLine = await ctx.mainInput.nextRecord();
  if (nextLine === null) {
    return 0;
  }

  if (variable) {
    setVariable(ctx, variable, nextLine);
  } else {
    setCurrentLine(ctx, nextLine);
  }

  ctx.NR++;
  ctx.FNR++;

  return 1;
}

/**
 * Read a record from a command pipe: "cmd" | getline [var]
 */
async function evalGetlineFromCommand(
  ctx: AwkRuntimeContext,
  variable: string | undefined,
  cmdExpr: AwkExpr,
): Promise<AwkValue> {
  const execFn = ctx.exec;
  if (!execFn) {
    return -1; // No exec function available
  }

  assertAwkDefenseContext(ctx, "getline command source");

  const cmd = toStr(ctx,
    await withDefenseContext(ctx, "getline command expression", () =>
      evalExpr(ctx, cmdExpr),
    ),
  );

  let stream = ctx.getlineCommandStreams.get(cmd);
  if (!stream) {
    // First time running this command, or again after close()
    let output: string;
    try {
      const result = await withDefenseContext(ctx, "getline command exec", () =>
        execFn(cmd),
      );
      // awk processes lines with regex / FS — decode bytes to UTF-8 so
      // `getline cmd |` from a piped command keeps multibyte fields whole.
      output = decodeBytesToUtf8(unsafeBytesFromLatin1(result.stdout));
    } catch (e) {
      if (e instanceof SecurityViolationError) {
        throw e;
      }
      rethrowFatalExecutionError(e);
      return -1; // Error running command
    }
    // (1ctx) the output shares the command's input budget
    stream = openStream(ctx, output);
    ctx.getlineCommandStreams.set(cmd, stream);
  }

  // (1ctx) one record under the current RS; NR and FNR stay
  const record = readRecord(ctx, stream);
  if (record === null) {
    return 0; // EOF
  }

  if (variable) {
    setVariable(ctx, variable, record);
  } else {
    setCurrentLine(ctx, record);
  }

  return 1;
}

/**
 * Read a record from an external file.
 */
async function evalGetlineFromFile(
  ctx: AwkRuntimeContext,
  variable: string | undefined,
  fileExpr: AwkExpr,
): Promise<AwkValue> {
  const fs = ctx.fs;
  if (!fs || !ctx.cwd) {
    return -1; // No filesystem access
  }

  assertAwkDefenseContext(ctx, "getline file source");
  const filename = toStr(ctx,
    await withDefenseContext(ctx, "getline filename evaluation", () =>
      evalExpr(ctx, fileExpr),
    ),
  );

  // Special handling for /dev/null - always returns EOF immediately
  if (filename === "/dev/null") {
    return 0;
  }

  const filePath = fs.resolvePath(ctx.cwd, filename);

  let stream = ctx.getlineFileStreams.get(filePath);
  if (!stream) {
    // First time reading this file, or again after close()
    let content: string;
    try {
      content = await withDefenseContext(ctx, "getline file read", () =>
        fs.readFile(filePath),
      );
    } catch (e) {
      if (e instanceof SecurityViolationError) {
        throw e;
      }
      rethrowFatalExecutionError(e);
      return -1; // Error reading file
    }
    // (1ctx) the file shares the command's input budget
    stream = openStream(ctx, content);
    ctx.getlineFileStreams.set(filePath, stream);
  }

  // (1ctx) one record under the current RS; NR and FNR stay
  const record = readRecord(ctx, stream);
  if (record === null) {
    return 0; // EOF
  }

  if (variable) {
    setVariable(ctx, variable, record);
  } else {
    setCurrentLine(ctx, record);
  }

  return 1;
}

async function evalTuple(
  ctx: AwkRuntimeContext,
  elements: AwkExpr[],
): Promise<AwkValue> {
  assertAwkDefenseContext(ctx, "tuple evaluation");
  // Tuple used as expression (comma operator): evaluate all, return last
  if (elements.length === 0) return "";
  for (let i = 0; i < elements.length - 1; i++) {
    await withDefenseContext(ctx, "tuple intermediate element", () =>
      evalExpr(ctx, elements[i]),
    );
  }
  return withDefenseContext(ctx, "tuple final element", () =>
    evalExpr(ctx, elements[elements.length - 1]),
  );
}
