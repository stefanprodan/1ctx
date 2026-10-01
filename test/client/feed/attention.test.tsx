// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The mark a finished run wears when the default decider judged it to
// need a person: on the feed's line and on the task's Runs list, at
// the threshold and above, and nothing under it or when not asked.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { needsAttention } from "../../../src/client/feed/Row.model.ts";
import { Row } from "../../../src/client/feed/Row.tsx";
import { RunRow } from "../../../src/client/views/projects/RunRow.tsx";
import type { FeedRow } from "../../../src/shared/api/sessions.ts";
import { ATTENTION_AT } from "../../../src/shared/contracts/decision.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

const now = new Date(2026, 8, 27, 12).getTime();

const run = (attention: number | null): FeedRow => {
  const session: SessionSummary = {
    archived: null,
    attention,
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
    automation: { id: "au1", name: "Check the cluster" },
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
      /@\w+ <\/span><span class="feed-attention">needs attention<\/span> · /,
    );
    expect(html).toContain("status-attention");
    for (const quiet of [null, 0.2, 0.499]) {
      expect(
        render(<Row row={run(quiet)} projectName="platform" now={now} />),
      ).not.toContain("needs attention");
    }
  });

  test("the task's Runs list says so after the agent, its icon bare", () => {
    const html = render(
      <RunRow row={run(0.5)} deadlineMs={600_000} now={now} />,
    );
    expect(html).toContain(
      '<span class="automations-attention">needs attention</span> · ',
    );
    expect(html).toContain("status-attention");
    expect(html).not.toContain('class="avatar');
    const quiet = render(
      <RunRow row={run(0.1)} deadlineMs={600_000} now={now} />,
    );
    expect(quiet).not.toContain("needs attention");
    expect(quiet).not.toContain("status-attention");
  });
});
