// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, spyOn, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import {
  CLOSING_ENTRIES,
  MAX_ENTRIES,
  STALE_TASK,
} from "../../../src/shared/contracts/external-task.ts";
import { DAY, fixture, HOUR, refuses } from "./fixture.ts";

test("idle unclaim reads raised and lowered limits and unclaims exactly at the boundary", () => {
  using f = fixture();
  const task = f.task("claimed");
  f.advance(25 * HOUR);
  f.limits.idle = 48;
  expect(f.area.unclaimIdle(f.now())).toBe(0);
  expect(f.area.show(task.id, null)!.idleHours).toBe(48);
  expect(f.area.claim(f.key, task.id).idleHours).toBe(48);
  f.limits.idle = 26;
  expect(f.area.unclaimIdle(f.now())).toBe(0);
  f.limits.idle = 25;
  expect(f.area.unclaimIdle(f.now())).toBe(1);
  const unclaimed = f.area.show(task.id, null)!;
  expect(unclaimed.task.task).toMatchObject({
    state: "open",
    claim: null,
    attentionAt: f.now(),
    revision: task.revision + 1,
    editRevision: 0,
  });
  expect(unclaimed.entries[0]).toMatchObject({
    kind: "unclaim",
    claimEnd: "idle",
    by: null,
    claimId: task.claimId,
    keyName: null,
    text: "after 25 hours without a report",
  });
  expect(f.area.store.claimById(task.claimId!)!.end_reason).toBe("idle");
  expect(f.area.unclaimIdle(f.now())).toBe(0);
  refuses(
    () => f.area.report(f.key, task.id, task.claimId!, "progress", "Late.", []),
    409,
    STALE_TASK,
  );
  const held = f.area.claim(f.key, task.id);
  expect(held.claimId).not.toBe(task.claimId);
  expect(f.area.unclaimIdle(f.now())).toBe(0);
});

test("an idle unclaim after one hour says hour", () => {
  using f = fixture();
  const task = f.task("claimed");
  f.limits.idle = 1;
  f.advance(HOUR);
  expect(f.area.unclaimIdle(f.now())).toBe(1);
  expect(f.area.show(task.id, null)!.entries[0]!.text).toBe(
    "after 1 hour without a report",
  );
});

test("reports and answers restart idle time, blocked tasks never idle out", () => {
  using f = fixture();
  const blocked = f.task("blocked");
  f.advance(8 * DAY);
  f.limits.idle = 1;
  expect(f.area.unclaimIdle(f.now())).toBe(0);
  f.area.answer(f.member.id, blocked.id, {
    state: "blocked",
    text: "The first path.",
  });
  expect(f.area.store.claimById(blocked.claimId!)!.active_at).toBe(f.now());
  f.advance(HOUR - 1);
  expect(f.area.unclaimIdle(f.now())).toBe(0);
  f.area.report(
    f.key,
    blocked.id,
    blocked.claimId!,
    "progress",
    "Working.",
    [],
  );
  f.advance(HOUR - 1);
  expect(f.area.unclaimIdle(f.now())).toBe(0);
  f.area.answer(f.member.id, blocked.id, {
    state: "claimed",
    text: "One more hint.",
  });
  f.advance(HOUR - 1);
  expect(f.area.unclaimIdle(f.now())).toBe(0);
  f.advance(1);
  expect(f.area.unclaimIdle(f.now())).toBe(1);
});

test("a fresh reclaim ignores old entries", () => {
  using f = fixture();
  const task = f.task("claimed");
  f.area.report(f.key, task.id, task.claimId!, "unclaim", "Pause.", []);
  f.advance(30 * DAY);
  const held = f.area.claim(f.key, task.id);
  expect(f.area.store.claimById(held.claimId)!.active_at).toBe(f.now());
  expect(f.area.unclaimIdle(f.now())).toBe(0);
});

test("a report between the scan and unclaim wins the transaction recheck", () => {
  using f = fixture();
  const task = f.task("claimed");
  f.advance(DAY);
  const scan = f.area.store.openClaims.bind(f.area.store);
  f.area.store.openClaims = (cutoff) => {
    const candidates = scan(cutoff);
    f.area.report(
      f.key,
      task.id,
      task.claimId!,
      "progress",
      "Just in time.",
      [],
    );
    return candidates;
  };
  expect(f.area.unclaimIdle(f.now())).toBe(0);
  expect(f.area.store.byId(task.id)!.state).toBe("claimed");
  f.area.store.openClaims = scan;
  f.advance(DAY);
  expect(f.area.unclaimIdle(f.now())).toBe(1);
  refuses(
    () =>
      f.area.report(f.key, task.id, task.claimId!, "result", "Too late.", []),
    409,
  );
  expect(f.area.store.byId(task.id)!.state).toBe("open");
});

test.serial(
  "access gone ends blocked claims with the caller's transaction",
  () => {
    using f = fixture();
    const blocked = f.task("blocked");
    const claimed = f.task("claimed");
    const other = f.create();
    f.area.claim(f.otherKey, other.id);
    const events: BusEvent[] = [];
    const stop = subscribe((e) => {
      if (e.type === "externalTask.changed") events.push(e);
    }, silent);
    try {
      expect(() =>
        transact(f.db, () => {
          expect(f.area.endClaims(() => [f.key.keyId])).toBe(2);
          expect(events).toEqual([]);
          throw new Error("rollback access change");
        }),
      ).toThrow("rollback access change");
      expect(f.area.store.byId(blocked.id)!.state).toBe("blocked");
      expect(f.area.store.byId(claimed.id)!.state).toBe("claimed");
      expect(events).toEqual([]);
      expect(f.area.endClaims([f.key.keyId])).toBe(2);
      expect(events).toHaveLength(2);
      for (const row of [blocked, claimed]) {
        expect(f.area.store.byId(row.id)).toMatchObject({
          state: "open",
          attentionAt: f.now(),
        });
        expect(f.area.show(row.id, null)!.entries[0]).toMatchObject({
          kind: "unclaim",
          claimEnd: "access_gone",
          by: null,
          claimId: row.claimId,
          keyName: null,
        });
        expect(f.area.store.claimById(row.claimId!)!.end_reason).toBe(
          "access_gone",
        );
      }
      expect(f.area.store.byId(other.id)!.state).toBe("claimed");
      expect(f.area.endClaims([f.key.keyId])).toBe(0);
    } finally {
      stop();
    }
  },
);

for (const scope of ["keys", "user"] as const) {
  test(`${scope} access endings cannot exhaust the entry budget of a live claim`, () => {
    using f = fixture();
    expect(MAX_ENTRIES).toBe(250);
    expect(CLOSING_ENTRIES).toBe(240);
    const task = f.create();
    f.fillEntries(task.id, CLOSING_ENTRIES - 1);
    const held = f.area.claim(f.key, task.id);
    f.area.report(
      f.key,
      task.id,
      held.claimId,
      "question",
      "Last question.",
      [],
    );
    expect(f.area.store.counted(task.id)).toBe(CLOSING_ENTRIES);
    refuses(
      () =>
        f.area.answer(f.owner.id, task.id, {
          state: "blocked",
          text: "Another answer.",
        }),
      409,
    );
    refuses(
      () =>
        f.area.report(
          f.key,
          task.id,
          held.claimId,
          "progress",
          "Another report.",
          [],
        ),
      409,
    );
    transact(f.db, () => {
      const events =
        scope === "keys"
          ? f.area.endForKeys([f.key.keyId])
          : f.area.endForUser(f.owner.id, [f.projectId]);
      expect(events).toHaveLength(1);
      return { result: undefined, events };
    });
    expect(f.area.store.byId(task.id)).toMatchObject({
      state: "open",
      claim: null,
      entries: CLOSING_ENTRIES + 2,
    });
    expect(f.area.store.counted(task.id)).toBe(CLOSING_ENTRIES + 1);
    expect(f.area.store.claimById(held.claimId)!.end_reason).toBe(
      "access_gone",
    );
    refuses(() => f.area.claim(f.key, task.id), 409);
    const cancelled = f.area.cancel(f.owner.id, task.id, { state: "open" });
    expect(cancelled.task.task.entries).toBe(CLOSING_ENTRIES + 3);
    expect(f.area.store.counted(task.id)).toBeLessThan(MAX_ENTRIES);
  });

  test.serial(
    `${scope} claim endings return events for the outermost commit`,
    () => {
      using f = fixture();
      const held = f.task("blocked");
      const end = () =>
        scope === "keys"
          ? f.area.endForKeys([f.key.keyId])
          : f.area.endForUser(f.owner.id, [f.projectId]);
      const events: BusEvent[] = [];
      const stop = subscribe((event) => {
        if (event.type === "externalTask.changed") events.push(event);
      }, silent);
      const write = () =>
        transact(f.db, () => {
          const pending = end();
          expect(pending).toHaveLength(1);
          expect(events).toEqual([]);
          return { result: undefined, events: pending };
        });
      try {
        expect(() =>
          transact(f.db, () => {
            write();
            expect(f.area.store.byId(held.id)!.state).toBe("open");
            expect(events).toEqual([]);
            throw new Error("rollback outer write");
          }),
        ).toThrow("rollback outer write");
        expect(events).toEqual([]);
        expect(f.area.store.byId(held.id)!.state).toBe("blocked");
        write();
        expect(events).toHaveLength(1);
        expect(f.area.store.claimById(held.claimId!)!.end_reason).toBe(
          "access_gone",
        );
      } finally {
        stop();
      }
    },
  );
}

test("idle scanning excludes fresh and blocked claims before opening transactions", () => {
  using f = fixture();
  const idle = f.task("claimed");
  f.task("blocked");
  f.advance(DAY);
  f.task("claimed");
  const candidates = f.area.store.openClaims(f.now() - DAY);
  expect(candidates.map((claim) => claim.id)).toEqual([idle.claimId!]);
  const transaction = spyOn(f.db, "transaction");
  try {
    expect(f.area.unclaimIdle(f.now())).toBe(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    transaction.mockClear();
    expect(f.area.unclaimIdle(f.now())).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
  } finally {
    transaction.mockRestore();
  }
});

test("open claim scans never load the saved response", () => {
  using f = fixture();
  const task = f.task("claimed");
  f.area.report(f.key, task.id, task.claimId!, "progress", "Working.", []);
  expect(f.area.store.claimById(task.claimId!)!.last_task).not.toBeNull();
  const [claim] = f.area.store.openClaims();
  expect(claim!.id).toBe(task.claimId!);
  expect(Object.hasOwn(claim!, "last_task")).toBe(false);
});

test("a reopen between the closed scan and deletion wins the recheck", () => {
  using f = fixture();
  const task = f.task("done");
  f.advance(365 * DAY);
  const expired = f.area.store.expired.bind(f.area.store);
  f.area.store.expired = (cutoff) => {
    const ids = expired(cutoff);
    f.area.reopen(f.owner.id, task.id, {
      state: "done",
      text: "Keep working.",
    });
    return ids;
  };
  expect(f.area.deleteClosed(f.now())).toBe(0);
  expect(f.area.store.byId(task.id)!.state).toBe("open");
});

for (const kind of ["idle", "access_gone"] as const) {
  test(`${kind} can end a claim in the reserved tail`, () => {
    using f = fixture();
    const task = f.task(kind === "idle" ? "claimed" : "blocked");
    f.fillEntries(task.id, 240);
    f.advance(DAY);
    expect(
      kind === "idle"
        ? f.area.unclaimIdle(f.now())
        : f.area.endClaims([f.key.keyId]),
    ).toBe(1);
    expect(f.area.store.counted(task.id)).toBe(241);
  });
}

test.serial(
  "closed retention uses the latest close and cascades each published deletion",
  () => {
    using f = fixture();
    const done = f.task("done");
    const cancelled = f.task("cancelled");
    const reopened = f.task("done");
    const reclosed = f.task("done");
    f.area.reopen(f.owner.id, reopened.id, {
      state: "done",
      text: "Continue.",
    });
    f.advance(20 * DAY);
    f.area.reopen(f.owner.id, reclosed.id, { state: "done", text: "Again." });
    f.area.cancel(f.owner.id, reclosed.id, { state: "open" });
    f.advance(10 * DAY);
    f.limits.days = 31;
    expect(f.area.deleteClosed(f.now())).toBe(0);
    f.limits.days = 30;
    const events: BusEvent[] = [];
    const stop = subscribe((e) => {
      if (e.type === "externalTask.deleted") events.push(e);
    }, silent);
    try {
      expect(f.area.deleteClosed(f.now())).toBe(2);
      expect(
        events
          .map((e) => (e.type === "externalTask.deleted" ? e.data.taskId : ""))
          .sort(),
      ).toEqual([done.id, cancelled.id].sort());
      for (const task of [done, cancelled]) {
        expect(f.area.projectOf(task.id)).toBeNull();
        expect(f.area.store.claimsCount(task.id)).toBe(0);
        expect(f.area.store.entries(task.id, null).entries).toEqual([]);
      }
      expect(f.area.store.byId(reopened.id)!.state).toBe("open");
      expect(f.area.store.byId(reclosed.id)!.state).toBe("cancelled");
      f.advance(20 * DAY);
      expect(f.area.deleteClosed(f.now())).toBe(1);
      expect(f.area.store.byId(reopened.id)!.state).toBe("open");
      expect(f.area.deleteClosed(f.now())).toBe(0);
    } finally {
      stop();
    }
  },
);

test("a claim's activeAt is its last report or answer, the idle sweep's basis", () => {
  using f = fixture();
  const task = f.task("claimed");
  const activeAt = () => f.area.store.byId(task.id)!.claim!.activeAt;
  expect(activeAt()).toBe(f.now());
  f.advance(2 * HOUR);
  f.area.report(f.key, task.id, task.claimId!, "progress", "Half.", []);
  expect(activeAt()).toBe(f.now());
  f.advance(3 * HOUR);
  f.area.answer(f.owner.id, task.id, { state: "claimed", text: "Go on." });
  const last = f.now();
  expect(activeAt()).toBe(last);
  expect(f.area.show(task.id, null)!.task.task.claim!.activeAt).toBe(last);
  const deadline = last + f.limits.idle * HOUR;
  f.at(deadline - 1);
  expect(f.area.unclaimIdle(f.now())).toBe(0);
  expect(f.area.store.byId(task.id)!.state).toBe("claimed");
  f.at(deadline);
  expect(f.area.unclaimIdle(f.now())).toBe(1);
  expect(f.area.store.byId(task.id)!).toMatchObject({
    state: "open",
    claim: null,
  });
});
