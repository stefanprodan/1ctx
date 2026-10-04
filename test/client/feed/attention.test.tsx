// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The mark a run wears when its agent or the runner marked it or a
// decider judged it to need a person: on the feed's line and on the
// task's Runs list with its reason, at the threshold and above, and
// nothing under it or when not marked. An automation's line with an
// open alert says since when and how many runs, in All and in the
// Flagged pick, and the Runs list filters the marked runs.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { matchesFilter } from "../../../src/client/data/automations-rows.ts";
import { FeedCard } from "../../../src/client/feed/FeedCard.tsx";
import {
  alertOf,
  alertWords,
  iconStatus,
  markReason,
  needsAttention,
  sinceText,
} from "../../../src/client/feed/Row.model.ts";
import { Row } from "../../../src/client/feed/Row.tsx";
import { OpenAttention } from "../../../src/client/views/projects/OpenAttention.tsx";
import { RunRow } from "../../../src/client/views/projects/RunRow.tsx";
import type { FeedRow } from "../../../src/shared/api/sessions.ts";
import { ATTENTION_AT } from "../../../src/shared/contracts/decision.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

const now = new Date(2026, 8, 27, 12).getTime();

const run = (
  attention: number | null,
  attentionReason: string | null = null,
): FeedRow => {
  const session: SessionSummary = {
    archived: null,
    attention,
    attentionReason,
    attentionSource: attentionReason === null ? null : "agent",
    attentionBy: attentionReason === null ? null : "coder",
    id: "s1",
    projectId: "p1",
    ownerId: "u1",
    agentId: "a1",
    origin: "automation",
    automationId: "au1",
    runSource: "schedule",
    forkedFromId: null,
    title: "Check the cluster",
    status: "done",
    revision: 2,
    createdAt: now - 60_000,
    lastActivityAt: now - 30_000,
    usage: null,
    disabledCapabilities: [],
  };
  return {
    agentRetired: false,
    session,
    agent: "sre",
    send: null,
    sendAgent: null,
    last: { seq: 2, author: "sre", text: "three objects failing" },
    automation: { id: "au1", name: "Check the cluster", alert: null },
    runBy: null,
    runs: null,
  };
};

describe("needs attention", () => {
  test("from the threshold up, never under it or unasked", () => {
    expect(ATTENTION_AT).toBe(0.5);
    expect(needsAttention({ attention: null })).toBe(false);
    expect(needsAttention({ attention: 0 })).toBe(false);
    expect(needsAttention({ attention: 0.49 })).toBe(false);
    expect(needsAttention({ attention: 0.5 })).toBe(true);
    expect(needsAttention({ attention: 1 })).toBe(true);
  });

  test("the feed's line says so after the agent, its icon orange", () => {
    const html = render(
      <Row row={run(0.91)} projectName="platform" now={now} />,
    );
    expect(html).toMatch(
      /@\w+ <\/span><span class="feed-attention">flagged<\/span> · /,
    );
    expect(html).toContain("status-attention");
    for (const quiet of [null, 0.2, 0.499]) {
      expect(
        render(<Row row={run(quiet)} projectName="platform" now={now} />),
      ).not.toContain("flagged");
    }
  });

  test("the task's Runs list says so after the agent, its icon bare", () => {
    const html = render(
      <RunRow row={run(0.5)} deadlineMs={600_000} now={now} />,
    );
    expect(html).toContain(
      '<span class="automations-attention">flagged</span> · ',
    );
    expect(html).toContain("status-attention");
    expect(html).not.toContain('class="avatar');
    const quiet = render(
      <RunRow row={run(0.1)} deadlineMs={600_000} now={now} />,
    );
    expect(quiet).not.toContain("flagged");
    expect(quiet).not.toContain("status-attention");
  });

  test("a failed run keeps its red words and never says flagged", () => {
    const failed = (): FeedRow => {
      const row = run(1);
      return {
        ...row,
        session: {
          ...row.session,
          status: "failed",
          attentionReason: "The run failed: timed out",
          attentionSource: "runner",
        },
      };
    };
    const feed = render(
      <Row row={failed()} projectName="platform" now={now} />,
    );
    const runs = render(
      <RunRow row={failed()} deadlineMs={600_000} now={now} />,
    );
    for (const html of [feed, runs]) {
      expect(html).not.toContain("flagged");
      expect(html).toContain("status-failed");
    }
    expect(feed).toContain('class="feed-bad"');
  });

  test("the reason follows the mark, a decider's mark has none", () => {
    expect(
      markReason({ attentionReason: null, attentionSource: "decider" }),
    ).toBeNull();
    expect(
      markReason({ attentionReason: "not ready", attentionSource: "agent" }),
    ).toBe("not ready");
    // the runner's words only repeat the status line
    expect(
      markReason({
        attentionReason: "The run failed.",
        attentionSource: "runner",
      }),
    ).toBeNull();
    const html = render(
      <RunRow
        row={run(1, "podinfo is not ready")}
        deadlineMs={600_000}
        now={now}
      />,
    );
    // only the mark is coloured
    expect(html).toContain(
      '<span class="automations-attention">flagged</span> · podinfo is not ready',
    );
  });

  test("the icon wears the mark only on a done run", () => {
    expect(iconStatus({ attention: 1, status: "done" })).toBe("attention");
    expect(iconStatus({ attention: 0.2, status: "done" })).toBe("done");
    expect(iconStatus({ attention: 1, status: "failed" })).toBe("failed");
    expect(iconStatus({ attention: 1, status: "stopped" })).toBe("stopped");
    const failed = run(1);
    failed.session = { ...failed.session, status: "failed" };
    const html = render(<RunRow row={failed} deadlineMs={600_000} now={now} />);
    expect(html).toContain("status-failed");
    expect(html).not.toContain("status-attention");
  });
});

describe("an open alert on an automation's line", () => {
  const opened = (runs: number | null): FeedRow => ({
    ...run(1, "podinfo is not ready"),
    automation: {
      id: "au1",
      name: "Check the cluster",
      alert: {
        since: now - 90 * 60_000,
        runs: 2,
        reason: "flux is behind",
        by: null,
      },
    },
    runs,
  });

  test("says since when and how many runs, the time alone today", () => {
    expect(sinceText(now - 90 * 60_000, now)).toBe("10:30");
    expect(sinceText(new Date(2026, 8, 25, 8, 5).getTime(), now)).toBe(
      "25 Sep 08:05",
    );
    expect(
      alertWords(
        { since: now - 90 * 60_000, runs: 1, reason: null, by: null },
        now,
      ),
    ).toBe("flagged since 10:30, 1 run");
  });

  test("All's line says it after the agent in place of the run's state, with the latest reason", () => {
    const html = render(
      <Row row={opened(7)} projectName="platform" now={now} />,
    );
    expect(html).toMatch(
      /@\w+ <\/span><span class="feed-attention">flagged since 10:30, 2 runs<\/span> · flux is behind/,
    );
    expect(html).not.toContain("three objects failing");
    expect(alertOf(opened(7), true)?.runs).toBe(2);
  });

  test("a run's own row keeps its own mark, a line in the pick says the alert", () => {
    const single = render(
      <Row row={opened(null)} projectName="platform" now={now} />,
    );
    expect(single).not.toContain("since 10:30");
    expect(single).toContain("three objects failing");
    const picked = render(
      <Row row={opened(null)} projectName="platform" line now={now} />,
    );
    expect(picked).toContain("flagged since 10:30, 2 runs");
    const closed = {
      ...opened(7),
      automation: { ...opened(7).automation!, alert: null },
    };
    expect(alertOf(closed, true)).toBeNull();
  });

  test("the feed's fourth pick is Flagged, every row a line", () => {
    const html = render(
      <FeedCard
        rows={[opened(null)]}
        projectName={() => null}
        search={{ value: "", onChange: () => {} }}
        filter={{ value: "attention", onPick: () => {} }}
        empty="Nothing flagged"
        now={now}
        more={{ next: false, loading: false, error: null }}
        onMore={() => {}}
      />,
    );
    expect(html).toContain("Flagged</");
    expect(html).toContain("flagged since 10:30, 2 runs");
  });

  test("the automation's page says the same at the top, with Dismiss", () => {
    const html = render(
      <OpenAttention
        id="au1"
        alert={{
          since: now - 90 * 60_000,
          runs: 2,
          reason: "flux is behind",
          by: null,
        }}
        now={now}
      />,
    );
    expect(html).toContain("Needs attention since 10:30, 2 runs");
    expect(html).toContain("flux is behind");
    expect(html).toContain(">Dismiss</button>");
  });

  test("with no reason the top names the decider that flagged its runs", () => {
    const html = render(
      <OpenAttention
        id="au1"
        alert={{ since: now - 90 * 60_000, runs: 4, reason: null, by: "jev" }}
        now={now}
      />,
    );
    expect(html).toContain("Flagged by the @jev decider");
  });

  test("the Runs list's filter holds the marked runs", () => {
    expect(matchesFilter(run(1), "attention")).toBeTrue();
    expect(matchesFilter(run(0.5), "attention")).toBeTrue();
    expect(matchesFilter(run(0.2), "attention")).toBeFalse();
    expect(matchesFilter(run(null), "attention")).toBeFalse();
  });
});
