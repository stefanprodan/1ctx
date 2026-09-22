// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { publish, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { collectLogs } from "../../helpers/app.ts";

test.serial("a listener failure uses its subscriber log", () => {
  const logs = collectLogs();
  const seen: string[] = [];
  const first = subscribe(() => {
    throw new TypeError("listener broke");
  }, logs.logFactory("sessions"));
  const second = subscribe((event) => seen.push(event.type), silent);
  try {
    publish({ type: "access.changed", data: { userIds: null } });
    expect(seen).toEqual(["access.changed"]);
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      level: "error",
      area: "sessions",
      msg: "listener failed",
      fields: {
        event: "access.changed",
        error: "listener broke",
        error_type: "TypeError",
      },
    });
  } finally {
    first();
    second();
  }
});
