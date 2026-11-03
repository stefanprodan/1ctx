// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An admin's clear of a channel, refused while any turn of it runs: its
// row says so, or the registry holds a send admitted but not freed. The
// check and the delete share one synchronous transaction, so no start
// lands in between.

import { transact } from "../db/index.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import type { Principal } from "../lib/http.ts";
import type { Registry } from "./registry.ts";
import type { RunnerDeps } from "./types.ts";

export function clearChannel(
  deps: Pick<RunnerDeps, "db" | "sessions" | "visible" | "clearChannel"> & {
    registry: Registry;
  },
  principal: Principal,
  sessionId: string,
): void {
  const session = deps.visible(principal, sessionId);
  if (session.origin !== "channel") {
    throw new BadRequest("only a channel is cleared");
  }
  transact(deps.db, () => {
    const current = deps.sessions.byId(session.id);
    if (current === null) throw new NotFound("no such chat");
    if (current.status === "running" || deps.registry.hasSession(current.id)) {
      throw new Conflict("a turn is running");
    }
    return { result: undefined, events: deps.clearChannel(current.id) };
  });
}
