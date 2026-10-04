// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The mark a send ends with, from its kind, its automation's mode, the
// agent's last reason, its cause and the cap that sent it to its answer;
// and what that end does to the automation's open alert.

import { describe, expect, test } from "bun:test";
import {
  alertChange,
  alertEvents,
  DEADLINE_REASON,
  decidesLater,
  FAILED_REASON,
  LIMIT_REASON,
  runMark,
} from "../../../src/server/runner/marks.ts";
import type { ActiveSend, CapReason } from "../../../src/server/runner/send.ts";
import {
  type AttentionMode,
  MAX_ATTENTION_REASON,
  type SendCause,
} from "../../../src/shared/words.ts";

const send = (
  fields: {
    kind?: ActiveSend["kind"];
    mode?: AttentionMode | null;
    reason?: string | null;
    answering?: CapReason | null;
    interrupted?: boolean;
  } = {},
) =>
  ({
    kind: fields.kind ?? "run",
    sessionId: "s1",
    answering: fields.answering ?? null,
    interrupted: fields.interrupted ?? false,
    policy: {
      agentName: "sre",
      automation:
        fields.mode === null
          ? null
          : {
              id: "au1",
              attentionMode: fields.mode ?? "agent",
              attentionGuidance: "",
            },
      attentionOffered: {
        attention:
          fields.reason === undefined || fields.reason === null
            ? { guidance: "", reason: null }
            : { guidance: "", reason: fields.reason },
      },
    },
  }) as unknown as ActiveSend;

const runner = (reason: string) =>
  ({ reason, source: "runner", by: null }) as const;

describe("runMark", () => {
  test("the runner's words by cause, none for a stop or a clean finish", () => {
    const by: Record<SendCause, unknown> = {
      finish: null,
      stop: null,
      shutdown: null,
      restart: null,
      failure: runner(FAILED_REASON),
      deadline: runner(DEADLINE_REASON),
    };
    for (const [cause, mark] of Object.entries(by)) {
      expect(runMark(send(), cause as SendCause)).toEqual(mark as never);
    }
  });

  test("a failure's first line after the fixed words, cut to fit", () => {
    expect(runMark(send(), "failure", "timed out\n  at fetch")).toEqual(
      runner("The run failed: timed out"),
    );
    expect(runMark(send(), "failure", " \n")).toEqual(runner(FAILED_REASON));
    const long = runMark(send(), "failure", "x".repeat(500))!.reason;
    expect(long.length).toBe(MAX_ATTENTION_REASON);
    expect(long.endsWith("…")).toBeTrue();
  });

  test("a spent budget, never the loop check", () => {
    for (const cap of ["tool_limit", "token_limit", "context_limit"] as const) {
      expect(runMark(send({ answering: cap }), "finish")).toEqual(
        runner(LIMIT_REASON),
      );
    }
    expect(runMark(send({ answering: "tool_loop" }), "finish")).toBeNull();
  });

  test("the agent's reason first, whatever the cause", () => {
    const agent = { reason: "not ready", source: "agent", by: "sre" } as const;
    for (const cause of ["finish", "failure", "deadline", "stop"] as const) {
      expect(runMark(send({ reason: "not ready" }), cause)).toEqual(agent);
    }
  });

  test("nothing for a chat or an automation set to off", () => {
    expect(runMark(send({ kind: "chat", mode: null }), "failure")).toBeNull();
    expect(runMark(send({ mode: "off", reason: "x" }), "failure")).toBeNull();
    expect(runMark(send({ mode: "decider" }), "failure")).toEqual(
      runner(FAILED_REASON),
    );
  });
});

describe("alertChange", () => {
  test("a mark opens, a clean finish closes, a stop leaves it", () => {
    const by: Record<SendCause, unknown> = {
      finish: "close",
      stop: null,
      shutdown: null,
      restart: null,
      failure: "open",
      deadline: "open",
    };
    for (const [cause, change] of Object.entries(by)) {
      expect(alertChange(send(), cause as SendCause)).toBe(change as never);
    }
    expect(alertChange(send({ answering: "tool_limit" }), "finish")).toBe(
      "open",
    );
  });

  test("the agent's mark opens it, never on a stop", () => {
    expect(alertChange(send({ reason: "not ready" }), "finish")).toBe("open");
    for (const cause of ["stop", "shutdown", "restart"] as const) {
      expect(alertChange(send({ reason: "not ready" }), cause)).toBeNull();
    }
  });

  test("a clean finish in the decider mode waits for the decider", () => {
    expect(decidesLater(send({ mode: "decider" }), "finish")).toBeTrue();
    expect(alertChange(send({ mode: "decider" }), "finish")).toBeNull();
    expect(
      decidesLater(send({ mode: "decider", reason: "x" }), "finish"),
    ).toBeFalse();
    expect(alertChange(send({ mode: "decider", reason: "x" }), "finish")).toBe(
      "open",
    );
    expect(decidesLater(send({ mode: "decider" }), "failure")).toBeFalse();
  });

  test("a finish a Stop cut after its answer leaves it, unless marked", () => {
    for (const mode of ["agent", "decider", "off"] as const) {
      const cut = send({ mode, interrupted: true });
      expect(alertChange(cut, "finish")).toBeNull();
      expect(decidesLater(cut, "finish")).toBeFalse();
    }
    expect(
      alertChange(send({ interrupted: true, reason: "x" }), "finish"),
    ).toBe("open");
    expect(alertChange(send({ interrupted: true }), "deadline")).toBe("open");
  });

  test("off: a clean finish closes, a failure changes nothing; a chat nothing", () => {
    expect(alertChange(send({ mode: "off" }), "finish")).toBe("close");
    expect(alertChange(send({ mode: "off" }), "failure")).toBeNull();
    expect(
      alertChange(send({ kind: "chat", mode: null }), "finish"),
    ).toBeNull();
  });

  test("the port is asked only with a change and an automation", () => {
    const asked: unknown[] = [];
    const port = {
      runEnded: (run: unknown, change: unknown) => {
        asked.push([run, change]);
        return [];
      },
    };
    alertEvents(port, send(), "stop", 5);
    alertEvents(port, send({ kind: "chat", mode: null }), "finish", 5);
    alertEvents(port, send(), "failure", 5);
    expect(asked).toEqual([
      [{ automationId: "au1", sessionId: "s1", endedAt: 5 }, "open"],
    ]);
  });
});
