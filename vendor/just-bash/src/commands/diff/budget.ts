/**
 * (1ctx) diff's work: every step of splitting, folding, matching and
 * comparing is charged to the command's work limit, the one grep's matcher
 * takes, across every pair of files one command compares.
 */

import { ExecutionAbortedError } from "../../interpreter/errors.js";
import { commandWorkLimit } from "../../limits.js";
import type { RuntimeCommandContext } from "../../types.js";

/** Steps of the compare that make one unit of the work limit. */
export const STEPS_PER_UNIT = 64;

/** The compare went past the command's work limit. */
export class DiffWorkLimitError extends Error {}

export interface WorkBudget {
  charge: (steps: number) => void;
  /** a quarter of what is left: past it a default compare gives up */
  giveUp: () => number;
}

/**
 * Charges the steps to the command's work limit; a default compare gives
 * up looking at a quarter of what is left, so only -d can run into it.
 */
export function workBudget(ctx: RuntimeCommandContext): WorkBudget {
  const limit = commandWorkLimit(ctx.limits);
  const maxSteps = limit * STEPS_PER_UNIT;
  let steps = 0;
  return {
    charge: (more: number) => {
      if (ctx.signal?.aborted) throw new ExecutionAbortedError();
      steps += more;
      if (steps > maxSteps) {
        throw new DiffWorkLimitError(`work limit exceeded (${limit})`);
      }
    },
    giveUp: () => (maxSteps - steps) / 4,
  };
}
