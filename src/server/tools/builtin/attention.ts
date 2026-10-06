// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// needs_attention, a run's own mark: the run's agent, asked alone in a
// step after the run, says the run needs a user, with a reason. It is
// held on the step's handle and written when the run ends, so a later
// call replaces the reason. The answer never says anyone was told, since
// nothing is sent.

import { sanitize } from "../../../shared/memory.ts";
import { cutCodePoints } from "../../../shared/text.ts";
import { hasLineBreak, MAX_ATTENTION_REASON } from "../../../shared/words.ts";
import type { AttentionHandle, Tool } from "../types.ts";

export const ATTENTION_TOOL = "needs_attention";

export const ATTENTION_DESCRIPTION = `Mark this run as needing attention, with a one-line reason a user reads, at most ${MAX_ATTENTION_REASON} characters. Call it when the run found something a user should act on, or could not do its job. The task may say when. A later call replaces the reason.`;

const REFUSED = "reason must be one line.";
const FILLER_REFUSED =
  "reason must say what a user should act on, not a placeholder.";

// the automation's own words on when, after the fixed text
export function attentionDescription(guidance: string): string {
  return guidance === ""
    ? ATTENTION_DESCRIPTION
    : `${ATTENTION_DESCRIPTION}\n\nWhen it needs attention: ${guidance}`;
}

// words a model writes in place of a reason ("placeholder-not-called")
const FILLER = new Set([
  "placeholder",
  "test",
  "todo",
  "dummy",
  "none",
  "na",
  "null",
  "ok",
]);

function placeholder(reason: string): boolean {
  const lower = reason.toLowerCase();
  if (lower.includes("placeholder")) return true;
  const words = lower
    .replaceAll("n/a", "na")
    .split(/[\s\-_.,:;!?|/()[\]"'`*#]+/)
    .filter(Boolean);
  return words.length > 0 && words.every((word) => FILLER.has(word));
}

// one cleaned line, or null. A long one is cut, never refused: refused
// at 202 characters, a model lost its mark in the step's two rounds
function oneLine(value: unknown): string | null {
  if (typeof value !== "string" || hasLineBreak(value.trim())) return null;
  const reason = sanitize(value);
  if (reason === "") return null;
  return [...reason].length <= MAX_ATTENTION_REASON
    ? reason
    : `${cutCodePoints(reason, MAX_ATTENTION_REASON - 1).trimEnd()}…`;
}

// the reason as stored; a throw is the model's to write again
export function checkReason(value: unknown): string {
  const reason = oneLine(value);
  if (reason === null) throw new Error(REFUSED);
  if (placeholder(reason)) throw new Error(FILLER_REFUSED);
  return reason;
}

export function makeAttentionTool(handle: AttentionHandle): Tool {
  return {
    name: ATTENTION_TOOL,
    description: attentionDescription(handle.guidance),
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
    async run(args) {
      handle.reason = checkReason(args.reason);
      return "Marked.";
    },
  };
}
