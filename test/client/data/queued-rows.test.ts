// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { queueOnto } from "../../../src/client/data/queued-rows.ts";
import type { QueuedMessage } from "../../../src/shared/contracts/session.ts";

const row = (
  id: string,
  state: QueuedMessage["state"],
  queuedAt: number,
): QueuedMessage => ({
  id,
  author: { id: "u-casey", username: "casey" },
  text: id,
  cut: false,
  uploads: 0,
  state,
  reason: state === "not-sent" ? "expired" : null,
  revision: 1,
  queuedAt,
});

const shown = (queued: readonly QueuedMessage[] | undefined) =>
  queued?.map((r) => [r.id, r.state]);

test("a row turning not sent is drawn once at every step", () => {
  // the author's notSent event of a revision lands before the watchers'
  // queue frame of the same revision
  const held = [row("q1", "queued", 1), row("q2", "queued", 2)];
  const mine = queueOnto(
    held,
    { shared: 4, mine: 4 },
    { revision: 5, mine: [row("q1", "not-sent", 1)] },
  );
  expect(shown(mine?.queued)).toEqual([
    ["q1", "not-sent"],
    ["q2", "queued"],
  ]);
  const shared = queueOnto(mine!.queued, mine!.at, {
    revision: 5,
    shared: [row("q2", "queued", 2)],
  });
  expect(shown(shared?.queued)).toEqual([
    ["q1", "not-sent"],
    ["q2", "queued"],
  ]);
});

test("a newer shared part keeps the not-sent rows held", () => {
  const out = queueOnto(
    [row("q1", "not-sent", 1), row("q2", "queued", 2)],
    { shared: 5, mine: 5 },
    { revision: 6, shared: [] },
  );
  expect(shown(out?.queued)).toEqual([["q1", "not-sent"]]);
});
