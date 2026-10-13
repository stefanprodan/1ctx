// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// attention, a run's own verdict: the run's agent, asked alone in a step
// after the run, says whether the run needs a user, with a reason when
// it does. No is a call too: offered alone with only a text way to say
// no, a fast model called it on every clean run. The verdict is held on
// the step's handle and written when the run ends, so a later call
// replaces it. The answer never says anyone was told, since nothing is
// sent.

import { sanitize } from "../../../shared/memory.ts";
import { cutCodePoints } from "../../../shared/text.ts";
import { hasLineBreak, MAX_ATTENTION_REASON } from "../../../shared/words.ts";
import type { AttentionHandle, Tool } from "../types.ts";

export const ATTENTION_TOOL = "attention";

export const ATTENTION_DESCRIPTION = `Give your verdict on this run. needed true, with a one-line reason a user reads, at most ${MAX_ATTENTION_REASON} characters, when the run found something a user should act on, or could not do its job; needed false, with no reason, when it did not. The task may say when. A later call replaces the verdict.`;

const NEEDED_REFUSED = "needed must be true or false.";
const MISSING = "needed true takes a one-line reason.";
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

// no reason at all, as against one that breaks the rules
function absent(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  );
}

export function makeAttentionTool(handle: AttentionHandle): Tool {
  return {
    name: ATTENTION_TOOL,
    description: attentionDescription(handle.guidance),
    parameters: {
      type: "object",
      properties: {
        needed: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["needed"],
      additionalProperties: false,
    },
    // a refused call leaves the verdict before it; a false one drops its
    // reason, never stored or shown
    async run(args) {
      if (typeof args.needed !== "boolean") throw new Error(NEEDED_REFUSED);
      if (args.needed && absent(args.reason)) throw new Error(MISSING);
      const reason = args.needed ? checkReason(args.reason) : null;
      handle.reason = reason;
      handle.answered = true;
      return reason === null ? "Checked." : "Marked.";
    },
  };
}
