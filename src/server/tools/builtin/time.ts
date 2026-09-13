// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The clock the tools and the runner share, formatted in a timezone.
// The runner imports dateLine to show the date line it sends.

import type { ToolContext } from "../types.ts";

export type CurrentTime = {
  timezone: string;
  datetime: string;
  day_of_week: string;
};

export const HOST_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function part(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((item) => item.type === type)?.value ?? "";
}

export function formatCurrentTime(
  epochMs: number,
  timezone: string,
): CurrentTime {
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

// the line the runner appends to the system prompt while a tool is on
export function dateLine(epochMs: number, timezone: string): string {
  const date = formatCurrentTime(epochMs, timezone);
  return `Today's date: ${date.day_of_week}, ${date.datetime.slice(0, 10)}`;
}

function timezone(args: Record<string, unknown>): string {
  if (typeof args.timezone !== "string" || args.timezone === "") {
    throw new Error("timezone must be a non-empty string");
  }
  return args.timezone;
}

export const timeTool = {
  name: "get_current_time",
  description: "Get the current time in a specific timezone.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: `IANA timezone name. Use ${HOST_TIMEZONE} when the user did not specify one.`,
      },
    },
    required: ["timezone"],
    additionalProperties: false,
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return JSON.stringify(formatCurrentTime(ctx.now(), timezone(args)));
  },
};
