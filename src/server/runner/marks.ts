// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The mark a run ends with (docs/automations.md, Attention).

import { cutText } from "../../shared/mcp.ts";
import { MAX_ATTENTION_REASON, type SendCause } from "../../shared/words.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { RunMark } from "../sessions/index.ts";
import type { ActiveSend, CapReason } from "./send.ts";

export const FAILED_REASON = "The run failed.";
export const DEADLINE_REASON = "The run hit its deadline.";
export const LIMIT_REASON = "The run hit a limit.";

// the budgets that send a run to its last answer round, where no tool
// is offered; the loop check is the model repeating itself, not a budget
const LIMITS: ReadonlySet<CapReason> = new Set([
  "tool_limit",
  "token_limit",
  "context_limit",
]);

// the strip says why it failed, which the fixed words alone never did
function failedReason(error: string | null): string {
  const line = error?.split("\n", 1)[0]?.trim() ?? "";
  return line === ""
    ? FAILED_REASON
    : cutText(`The run failed: ${line}`, MAX_ATTENTION_REASON);
}

function runnerReason(
  cause: SendCause,
  answering: CapReason | null,
  error: string | null,
): string | null {
  if (cause === "failure") return failedReason(error);
  if (cause === "deadline") return DEADLINE_REASON;
  if (cause === "finish" && answering !== null && LIMITS.has(answering)) {
    return LIMIT_REASON;
  }
  return null;
}

export function runMark(
  send: Pick<ActiveSend, "kind" | "answering" | "policy">,
  cause: SendCause,
  error: string | null = null,
): RunMark | null {
  const automation = send.policy.automation;
  if (
    send.kind !== "run" ||
    automation === null ||
    automation.attentionMode === "off"
  ) {
    return null;
  }
  const said = send.policy.attentionOffered?.attention?.reason ?? null;
  if (said !== null) {
    return { reason: said, source: "agent", by: send.policy.agentName };
  }
  const reason = runnerReason(cause, send.answering, error);
  return reason === null ? null : { reason, source: "runner", by: null };
}

// what a run's end does to its automation's open alert
export type AlertChange = "open" | "close";

// the automations area's open alert, built after the runner
export type AlertsPort = {
  // in the caller's transaction: the alert opened, joined or closed by
  // a run that ended at endedAt, and the events to publish
  runEnded(
    run: { automationId: string; sessionId: string; endedAt: number },
    change: AlertChange,
  ): BusEvent[];
};

// what the alert reads of a run's end
type Ended = Pick<ActiveSend, "kind" | "answering" | "policy" | "interrupted">;

// a run in the decider mode that finished with no mark, which no Stop or
// shutdown reached after its answer: the decider's answer, after the
// run, opens or closes the alert, never the run's end
export function decidesLater(send: Ended, cause: SendCause): boolean {
  return (
    send.kind === "run" &&
    cause === "finish" &&
    !send.interrupted &&
    send.policy.automation?.attentionMode === "decider" &&
    runMark(send, cause) === null
  );
}

// A mark opens the alert, a clean finish closes it unless the decider
// is to have its say; a stop, a shutdown or a restart leaves it as it
// is, the agent's mark of a stopped run included. A finish whose work
// after the answer a Stop or a shutdown cut opens or joins with its
// mark as usual, the step's (done before the cut) or the runner's (a
// limit); with none it leaves the alert. In the off mode nothing marks: a clean
// finish still closes an open alert, and a failure or a deadline
// changes nothing
export function alertChange(send: Ended, cause: SendCause): AlertChange | null {
  if (send.kind !== "run" || send.policy.automation === null) return null;
  if (cause !== "finish" && cause !== "failure" && cause !== "deadline") {
    return null;
  }
  if (runMark(send, cause) !== null) return "open";
  if (cause !== "finish" || send.interrupted) return null;
  if (decidesLater(send, cause)) return null;
  return "close";
}

// the run's end over its automation's open alert, in its transaction
export function alertEvents(
  alerts: AlertsPort,
  send: Ended & Pick<ActiveSend, "sessionId">,
  cause: SendCause,
  endedAt: number,
): BusEvent[] {
  const change = alertChange(send, cause);
  const automationId = send.policy.automation?.id;
  if (change === null || automationId === undefined) return [];
  return alerts.runEnded(
    { automationId, sessionId: send.sessionId, endedAt },
    change,
  );
}
