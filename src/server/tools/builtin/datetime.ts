// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The datetime tool, shaped like OpenRouter's server tool of the same
// name: an optional IANA timezone, UTC when left out, so the answer
// never depends on where the binary runs.

import type { ToolContext } from "../types.ts";

export type Datetime = {
  timezone: string;
  datetime: string;
  day_of_week: string;
};

export const DEFAULT_TIMEZONE = "UTC";

function part(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((item) => item.type === type)?.value ?? "";
}

export function formatDatetime(epochMs: number, timezone: string): Datetime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "long",
      timeZoneName: "longOffset",
    }).formatToParts(new Date(epochMs));
  } catch {
    throw new Error(`unknown timezone "${timezone}"`);
  }
  const offsetName = part(parts, "timeZoneName");
  const offset = offsetName === "GMT" ? "+00:00" : offsetName.slice(3);
  return {
    timezone,
    datetime: `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}T${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}${offset}`,
    day_of_week: part(parts, "weekday"),
  };
}

// a model often sends null or an empty string for an optional field
function timezone(args: Record<string, unknown>): string {
  const value = args.timezone;
  if (value === undefined || value === null || value === "") {
    return DEFAULT_TIMEZONE;
  }
  if (typeof value !== "string") throw new Error("timezone must be a string");
  return value;
}

export const datetimeTool = {
  name: "datetime",
  description: "Get the current date and time.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          "IANA timezone name (e.g. America/New_York, Europe/London, Asia/Tokyo)",
        default: DEFAULT_TIMEZONE,
      },
    },
    additionalProperties: false,
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return JSON.stringify(formatDatetime(ctx.now(), timezone(args)));
  },
};
