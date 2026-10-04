// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A run's foot, one card: the strip on top when the run needs
// attention, with any reason, cut until opened; under it the bar names
// the automation as a link, plain when it was deleted, then the state,
// whose rest a phone hides, the icon in the run's own status colour.
// While the run is one of its automation's open alert the strip has
// Dismiss, its own button, which never opens the strip.

import { describe, expect, test } from "bun:test";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import {
  AttentionLine,
  AttentionStrip,
} from "../../../src/client/views/sessions/AttentionStrip.tsx";
import {
  footState,
  inOpenAlert,
  runOf,
} from "../../../src/client/views/sessions/RunFoot.model.ts";
import { RunFoot } from "../../../src/client/views/sessions/RunFoot.tsx";
import type { FeedRow } from "../../../src/shared/api/sessions.ts";
import type {
  SendSummary,
  SessionSummary,
} from "../../../src/shared/contracts/session.ts";

const now = Date.UTC(2026, 9, 4, 12);

const send: SendSummary = {
  id: "d1",
  sessionId: "s1",
  kind: "run",
  userId: "u1",
  agentId: "a1",
  providerId: "pr1",
  model: "m",
  status: "done",
  cause: "finish",
  error: null,
  firstMessageId: "m1",
  rounds: 2,
  toolCalls: 1,
  memoryRound: null,
  attentionRound: null,
  memoryFrom: null,
  memoryError: null,
  memorySkipped: null,
  summoned: false,
  tokens: 54_500,
  startedAt: now - 60_000,
  finishedAt: now - 8_000,
};

const row = (
  changes: Partial<SessionSummary> = {},
  sent: Partial<SendSummary> = {},
): FeedRow => ({
  agentRetired: false,
  session: {
    archived: null,
    attention: null,
    attentionReason: null,
    attentionSource: null,
    attentionBy: null,
    id: "s1",
    projectId: "p1",
    ownerId: "u1",
    agentId: "a1",
    origin: "automation",
    automationId: "au1",
    runSource: "schedule",
    forkedFromId: null,
    title: "nightly",
    status: "done",
    revision: 1,
    createdAt: now - 60_000,
    lastActivityAt: now - 8_000,
    usage: null,
    disabledCapabilities: [],
    ...changes,
  },
  agent: null,
  send: { ...send, ...sent },
  sendAgent: null,
  last: null,
  automation: null,
  runBy: null,
  runs: null,
});

const nightly = runOf("au1", { id: "au1", name: "Check the cluster" }, true);

const foot = (r: FeedRow, of = nightly) =>
  render(<RunFoot row={r} runOf={of} onStop={async () => {}} />);

describe("which automation a run is of", () => {
  test("a listed automation is its name and its page", () => {
    expect(nightly).toEqual({
      name: "Check the cluster",
      href: "/automations/au1",
    });
  });

  test("a deleted one is plain words, as is one still loading", () => {
    expect(runOf(null, null, false)).toEqual({
      name: "a deleted automation",
      href: null,
    });
    expect(runOf("au1", null, true)).toEqual({
      name: "a deleted automation",
      href: null,
    });
    expect(runOf("au1", null, false)).toEqual({
      name: "an automation",
      href: null,
    });
  });
});

describe("the foot's state", () => {
  test("a done run's main part is how long, the rest what it cost", () => {
    expect(footState(row(), now)).toEqual({
      main: "done in 52s",
      more: "54.5K tokens",
    });
    expect(footState(row({}, { tokens: 0 }), now)).toEqual({
      main: "done in 52s",
      more: null,
    });
  });

  test("a running run keeps its clock, the calls are the rest", () => {
    const running = (toolCalls: number) =>
      footState(
        row(
          { status: "running" },
          { status: "running", toolCalls, finishedAt: null },
        ),
        now,
      );
    expect(running(0).more).toBeNull();
    expect(running(0).main).toMatch(/^working · [^·]+$/);
    expect(running(1).main).toBe(running(0).main);
    expect(running(1).more).toBe("1 tool call");
    expect(running(3).more).toBe("3 tool calls");
  });

  test("any other state is split at its first dot", () => {
    expect(
      footState(
        row({ status: "failed" }, { status: "failed", error: "boom\nmore" }),
        now,
      ),
    ).toEqual({ main: "failed", more: "boom" });
    expect(
      footState(row({ status: "stopped" }, { status: "stopped" }), now),
    ).toEqual({ main: "stopped", more: null });
  });
});

describe("a run's foot", () => {
  test("names its automation as a link, the state whole, the rest apart", () => {
    const html = foot(row());
    expect(html).toStartWith('<div class="card chat-run-box">');
    expect(html).toContain('<span class="chat-run-of">Run of</span>');
    expect(html).toContain(
      '<a class="chat-run-link chat-run-name cut" href="/automations/au1">Check the cluster</a>',
    );
    expect(html).toContain(
      '<span class="chat-run-state"> · done in 52s</span>',
    );
    expect(html).toContain(
      '<span class="chat-run-more cut"> · 54.5K tokens</span>',
    );
    expect(html).not.toContain("chat-attention");
  });

  test("a deleted automation's words are plain, never a link", () => {
    const html = foot(row(), runOf("au1", null, true));
    expect(html).toContain(
      '<span class="chat-run-words cut">a deleted automation</span>',
    );
    expect(html).not.toContain("<a ");
  });

  test("a marked run has the strip on top, the bar in its own colour", () => {
    const html = foot(
      row({
        attention: 1,
        attentionReason: "podinfo is not ready",
        attentionSource: "agent",
      }),
    );
    expect(html).toStartWith(
      '<div class="card chat-run-box"><div class="chat-attention"><button type="button" class="chat-attention-line chat-attention-toggle" aria-expanded="false">',
    );
    expect(html).toContain(
      '<span class="chat-attention-title">Needs attention</span> podinfo is not ready',
    );
    expect(html).toContain("status-done");
    expect(html).not.toContain("status-attention");
    expect(html.match(/podinfo is not ready/g)).toHaveLength(1);
  });

  test("the runner's reason shows in the strip", () => {
    const html = foot(
      row(
        {
          status: "failed",
          attention: 1,
          attentionReason: "The run failed.",
          attentionSource: "runner",
        },
        { status: "failed", error: "boom" },
      ),
    );
    expect(html).toContain(
      '<span class="chat-attention-title">Needs attention</span> The run failed.',
    );
    expect(html).toContain("status-failed");
    expect(html).toContain('<span class="chat-run-state error">');
  });

  test("a decider's mark names who flagged it", () => {
    const html = foot(
      row({ attention: 0.9, attentionSource: "decider", attentionBy: "jev" }),
    );
    expect(html).toContain(
      '<span class="chat-attention-title">Needs attention</span> <span class="chat-attention-by">· flagged by the @jev decider</span>',
    );
    expect(html.replace(/<[^>]+>/g, "")).toStartWith(
      "Needs attention · flagged by the @jev decider",
    );
  });

  test("an agent's or the runner's mark never names who flagged it", () => {
    for (const attentionSource of ["agent", "runner"] as const) {
      const html = foot(
        row({ attention: 1, attentionSource, attentionBy: "coder" }),
      );
      expect(html).toContain("Needs attention");
      expect(html).not.toContain("chat-attention-by");
    }
  });

  test("an unmarked run has no strip", () => {
    expect(foot(row({ attention: 0.2 }))).not.toContain("chat-attention");
  });

  test("an archived chat's foot is the card with no strip", () => {
    const html = render(
      <RunFoot
        row={row({ origin: "chat", automationId: null, attention: 1 })}
        archived="Archived on 4 Oct"
        onStop={async () => {}}
      />,
    );
    expect(html).toStartWith('<div class="card chat-run-box">');
    expect(html).toContain("Archived on 4 Oct");
    expect(html).not.toContain("Run of");
    expect(html).not.toContain("chat-attention");
  });
});

describe("the attention strip", () => {
  test("starts closed, the reason cut", () => {
    const html = render(<AttentionStrip reason="podinfo is not ready" />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("chat-attention-open");
    expect(html).toContain("chat-attention-chevron");
  });

  test("the button's name has a space between the title and the reason", () => {
    const html = render(<AttentionStrip reason="podinfo is not ready" />);
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toBe("Needs attention podinfo is not ready");
  });

  test("open, the reason is whole", () => {
    const html = render(
      <AttentionLine reason="podinfo is not ready" open onToggle={() => {}} />,
    );
    expect(html).toContain(
      '<div class="chat-attention chat-attention-open"><button type="button" class="chat-attention-line chat-attention-toggle" aria-expanded="true"',
    );
  });

  test.serial("a press toggles it", () => {
    let toggled = 0;
    const previous = options.vnode;
    let press: (() => void) | undefined;
    options.vnode = (vnode: VNode) => {
      previous?.(vnode);
      if (vnode.type === "button") {
        press = (vnode.props as { onClick?: () => void }).onClick;
      }
    };
    try {
      render(
        <AttentionLine
          reason="podinfo is not ready"
          open={false}
          onToggle={() => {
            toggled++;
          }}
        />,
      );
    } finally {
      options.vnode = previous;
    }
    press?.();
    expect(toggled).toBe(1);
  });

  test("with no reason it says so alone, with nothing to open", () => {
    const html = render(<AttentionStrip reason={null} />);
    expect(html).toContain("Needs attention");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("chat-attention-chevron");
  });

  test("with no reason and no name it says Needs attention alone", () => {
    const html = render(<AttentionStrip reason={null} by={null} />);
    expect(html.replace(/<[^>]+>/g, "")).toBe("Needs attention");
    expect(html).not.toContain("chat-attention-by");
  });

  test("with a reason the decider is left out", () => {
    const html = render(
      <AttentionStrip reason="podinfo is not ready" by="coder" />,
    );
    expect(html.replace(/<[^>]+>/g, "")).toBe(
      "Needs attention podinfo is not ready",
    );
  });
});

describe("Dismiss in the strip", () => {
  const alert = (since: number) => ({
    since,
    runs: 2,
    reason: null,
    by: "jev",
  });

  test("only for a marked run that ended at or after the alert opened", () => {
    const marked = {
      attention: 1,
      status: "done" as const,
      lastActivityAt: 50,
    };
    expect(inOpenAlert(marked, alert(50))).toBeTrue();
    expect(inOpenAlert(marked, alert(40))).toBeTrue();
    expect(inOpenAlert(marked, alert(60))).toBeFalse();
    expect(inOpenAlert(marked, null)).toBeFalse();
    expect(inOpenAlert({ ...marked, attention: 0.2 }, alert(40))).toBeFalse();
    expect(
      inOpenAlert({ ...marked, status: "running" as const }, alert(40)),
    ).toBeFalse();
  });

  test("is drawn beside the line, and gone once dismissed", () => {
    const marked = row({ attention: 1, attentionReason: "not ready" });
    const html = render(
      <RunFoot
        row={marked}
        onStop={async () => {}}
        onDismiss={async () => {}}
      />,
    );
    expect(html).toContain(
      '</button><button type="button" class="btn-text chat-attention-dismiss">Dismiss</button></div>',
    );
    const after = render(<RunFoot row={marked} onStop={async () => {}} />);
    expect(after).toContain("chat-attention-title");
    expect(after).not.toContain("Dismiss");
    const bare = render(
      <AttentionLine
        reason={null}
        open={false}
        onToggle={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(bare).toContain("Dismiss");
  });

  test.serial("a press dismisses and never toggles the strip", () => {
    let toggled = 0;
    let dismissed = 0;
    const previous = options.vnode;
    const presses: (() => void)[] = [];
    options.vnode = (vnode: VNode) => {
      previous?.(vnode);
      if (vnode.type === "button") {
        const props = vnode.props as { onClick?: () => void; class?: string };
        if (props.class?.includes("chat-attention-dismiss") && props.onClick) {
          presses.push(props.onClick);
        }
      }
    };
    try {
      render(
        <AttentionLine
          reason="not ready"
          open={false}
          onToggle={() => {
            toggled++;
          }}
          onDismiss={() => {
            dismissed++;
          }}
        />,
      );
    } finally {
      options.vnode = previous;
    }
    expect(presses).toHaveLength(1);
    presses[0]!();
    expect(dismissed).toBe(1);
    expect(toggled).toBe(0);
  });
});
