// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A line of the Runs log: the bare icon says what started the run, the
// clock, the bolt or the restart arrow, and its title says it in words.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Icon, type IconName } from "../../../src/client/lib/icons.tsx";
import { RunRow } from "../../../src/client/views/projects/RunRow.tsx";
import type { StreamRow } from "../../../src/shared/api/sessions.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

const now = Date.UTC(2026, 9, 1, 12);

const row = (changes: Partial<SessionSummary>): StreamRow => ({
  agentRetired: false,
  session: {
    archived: null,
    attention: null,
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
    lastActivityAt: now - 30_000,
    usage: null,
    disabledCapabilities: [],
    ...changes,
  },
  agent: "assistant",
  send: null,
  sendAgent: null,
  last: null,
  automation: { id: "au1", name: "nightly" },
  runBy:
    changes.runSource === "manual" ? { id: "u1", username: "casey" } : null,
  runs: null,
});

// an icon's path as the page draws it
const path = (name: IconName) =>
  /<path d="[^"]+"/.exec(render(<Icon name={name} />))![0];

const drawn = (changes: Partial<SessionSummary>) =>
  render(<RunRow row={row(changes)} deadlineMs={600_000} now={now} />);

describe("the Runs log's source icon", () => {
  test("a restart run draws the restart arrow titled in words", () => {
    const html = drawn({ runSource: "restart" });
    expect(html).toContain('title="Restarted"');
    expect(html).toContain(path("redo"));
    expect(html).not.toContain(path("clock"));
  });

  test("a scheduled run keeps the clock and a manual one the bolt", () => {
    const scheduled = drawn({ runSource: "schedule" });
    expect(scheduled).toContain('title="Scheduled"');
    expect(scheduled).toContain(path("clock"));
    const manual = drawn({ runSource: "manual" });
    expect(manual).toContain('title="@casey"');
    expect(manual).toContain(path("bolt"));
  });

  test("a deferred run's title says so, unless it is a restart run", () => {
    const deferred = (changes: Partial<SessionSummary>) =>
      render(
        <RunRow row={row(changes)} deadlineMs={600_000} now={now} deferred />,
      );
    expect(deferred({ runSource: "schedule" })).toContain(
      'title="Scheduled, deferred by a restart"',
    );
    expect(deferred({ runSource: "restart" })).toContain('title="Restarted"');
  });
});
