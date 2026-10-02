/**
 * Date/time-related jq builtins
 *
 * Handles date and time functions like now, gmtime, mktime, strftime, strptime, etc.
 */

import type { EvalContext } from "../evaluator.js";
import type { AstNode } from "../parser.js";
import type { QueryValue } from "../value-operations.js";
// (1ctx jq-dates)
import {
  gmtimeOf,
  localtimeOf,
  strftimeText,
  strptimeFields,
  timegm,
  tmFields,
  type Zone,
  zoneName,
} from "./time-format.js";

type EvalFn = (
  value: QueryValue,
  ast: AstNode,
  ctx: EvalContext,
) => QueryValue[];

const ISO_UTC_FORMAT = "%Y-%m-%dT%H:%M:%SZ";
// strftime's zone: jq's gmtime names it GMT (1ctx jq-dates)
const GMT: Zone = { name: "GMT", offset: 0 };

/**
 * Handle date builtins that need evaluate function for arguments.
 * Returns null if the builtin name is not a date builtin handled here.
 */
export function evalDateBuiltin(
  value: QueryValue,
  name: string,
  args: AstNode[],
  ctx: EvalContext,
  evaluate: EvalFn,
): QueryValue[] | null {
  // jq 1.8's conversions on glibc, any year, every C conversion, and
  // strptime beyond the one ISO format upstream read (1ctx jq-dates)
  const tz = () => zoneName(ctx.env?.get("TZ"));
  const formats = (fn: string): string[] =>
    evaluate(value, args[0], ctx).map((fmt) => {
      if (typeof fmt !== "string") {
        throw new Error(`${fn}/1 requires a string format`);
      }
      return fmt;
    });
  const formatted = (fn: string, fmt: string): string => {
    const local = fn === "strflocaltime";
    if (typeof value === "number") {
      if (!local) return strftimeText(gmtimeOf(value), fmt, GMT, fn);
      const { tm, zone } = localtimeOf(value, tz());
      return strftimeText(tm, fmt, zone, fn);
    }
    if (!Array.isArray(value)) {
      throw new Error(`${fn}/1 requires parsed datetime inputs`);
    }
    const seconds = timegm(tmFields(value, `${fn}/1`));
    const zone = local ? localtimeOf(seconds, tz()).zone : GMT;
    return strftimeText(gmtimeOf(seconds), fmt, zone, fn);
  };
  const parsed = (fmt: string): QueryValue => {
    if (typeof value !== "string") {
      throw new Error("strptime/1 requires string inputs and arguments");
    }
    const found = strptimeFields(value, fmt);
    if (!found) {
      throw new Error(`date "${value}" does not match format "${fmt}"`);
    }
    return found.rest === "" ? found.tm : [...found.tm, found.rest];
  };
  switch (name) {
    case "now":
      return [Date.now() / 1000];

    case "gmtime":
    case "localtime":
      if (typeof value !== "number") {
        throw new Error(`${name}() requires numeric inputs`);
      }
      return [name === "gmtime" ? gmtimeOf(value) : localtimeOf(value, tz()).tm];

    case "mktime":
      return [timegm(tmFields(value, "mktime"))];

    case "strftime":
    case "strflocaltime":
      if (args.length !== 1) return null;
      return formats(name).map((fmt) => formatted(name, fmt));

    case "todate":
    case "todateiso8601":
      return [formatted("strftime", ISO_UTC_FORMAT)];

    case "strptime":
      if (args.length !== 1) return null;
      return formats(name).map(parsed);

    case "fromdate":
    case "fromdateiso8601":
      return [timegm(tmFields(parsed(ISO_UTC_FORMAT), "mktime"))];

    default:
      return null;
  }
}
