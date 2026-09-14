// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Events leave transact() after the outermost commit and never when any
// body on the way throws.

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { memoryDb } from "../../helpers/db.ts";

const revoked = (id: string): BusEvent => ({
  type: "login.revoked",
  data: { userId: id, loginId: null },
});

function capture() {
  const seen: string[] = [];
  const stop = subscribe((e) => {
    if (e.type === "login.revoked") seen.push(e.data.userId);
  });
  return { seen, stop };
}

describe("transact", () => {
  test.serial("publishes after commit, in order", () => {
    const db = memoryDb();
    const { seen, stop } = capture();
    try {
      const n = transact(db, () => {
        expect(seen).toEqual([]);
        return { result: 1, events: [revoked("a"), revoked("b")] };
      });
      expect(n).toBe(1);
      expect(seen).toEqual(["a", "b"]);
    } finally {
      stop();
    }
  });

  test.serial("publishes nothing when the body throws", () => {
    const db = memoryDb();
    const { seen, stop } = capture();
    try {
      expect(() =>
        transact(db, () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(seen).toEqual([]);
    } finally {
      stop();
    }
  });

  test.serial("a nested body's events wait for the outermost commit", () => {
    const db = memoryDb();
    const { seen, stop } = capture();
    try {
      transact(db, () => {
        transact(db, () => ({ result: 0, events: [revoked("inner")] }));
        expect(seen).toEqual([]);
        return { result: 0, events: [revoked("outer")] };
      });
      expect(seen).toEqual(["inner", "outer"]);
    } finally {
      stop();
    }
  });

  test.serial(
    "a nested body's events are dropped when the outer throws",
    () => {
      const db = memoryDb();
      const { seen, stop } = capture();
      try {
        expect(() =>
          transact(db, () => {
            transact(db, () => ({ result: 0, events: [revoked("inner")] }));
            throw new Error("outer boom");
          }),
        ).toThrow("outer boom");
        expect(seen).toEqual([]);
        // and the next transaction starts clean
        transact(db, () => ({ result: 0, events: [revoked("later")] }));
        expect(seen).toEqual(["later"]);
      } finally {
        stop();
      }
    },
  );

  test.serial("a nested body that throws loses only its own events", () => {
    const db = memoryDb();
    const { seen, stop } = capture();
    try {
      transact(db, () => {
        try {
          transact(db, () => {
            throw new Error("inner boom");
          });
        } catch {}
        return { result: 0, events: [revoked("outer")] };
      });
      expect(seen).toEqual(["outer"]);
    } finally {
      stop();
    }
  });

  test.serial(
    "a rolled-back middle body takes its inner events with it",
    () => {
      const db = memoryDb();
      const { seen, stop } = capture();
      try {
        transact(db, () => {
          try {
            transact(db, () => {
              transact(db, () => ({ result: 0, events: [revoked("deep")] }));
              throw new Error("middle boom");
            });
          } catch {}
          transact(db, () => ({ result: 0, events: [revoked("sibling")] }));
          return { result: 0, events: [revoked("outer")] };
        });
        expect(seen).toEqual(["sibling", "outer"]);
      } finally {
        stop();
      }
    },
  );
});
