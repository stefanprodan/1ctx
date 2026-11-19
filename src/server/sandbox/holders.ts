// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The holds on one lease: a chat's commands and its subagents' hold its
// sandbox at once. Each hold lets go once, by a release, a recycle or a
// retire. A recycle dooms the lease and stops the other holders at
// once, since what the sandbox holds is unknown from then on; a retire
// dooms it and lets them finish.

import type { ShellCall } from "../bash/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { Lease } from "./book.ts";
import type { Gateway } from "./gateway.ts";
import type { SandboxHold } from "./hold.ts";
import type { Network } from "./network.ts";
import { bounded } from "./waits.ts";

// commands one sandbox runs at once, a chat's and its subagents': each
// holds its mount in server memory until it ends, so with sandboxesMax
// this bounds that memory; a command past it waits in acquire()
export const SANDBOX_COMMANDS = 6;

export function holdOf(
  lease: Lease,
  gateway: Gateway,
  ends: { failed(): void; release(): void },
): SandboxHold {
  let done = false;
  return {
    sandbox: lease.name,
    keepAlivePid: lease.pid!,
    keepAliveStart: lease.started!,
    workspace: lease.workspace!,
    gateway,
    synced: lease.synced,
    network: lease.network,
    notice: "",
    failed: ends.failed,
    lost: lease.lost.signal,
    turn: (signal) => lease.turns.take(signal),
    release: () => {
      if (done) return;
      done = true;
      ends.release();
    },
    recycle: (reason) => {
      if (done) return;
      done = true;
      lease.doomed = true;
      lease.recycled ??= reason;
      if (!lease.lost.signal.aborted)
        lease.lost.abort(new Error("the sandbox was recycled"));
      ends.release();
    },
    retire: (reason) => {
      if (done) return;
      done = true;
      lease.doomed = true;
      lease.recycled ??= reason;
      ends.release();
    },
  };
}

// the network set up in the sandbox's turn, since its holders run at
// once; a turn not had by the deadline is busy, and lets the hold go.
// A sibling's recycle while it waits sends the caller to a fresh one
export async function configureInTurn(
  net: Network,
  clock: Clock,
  hold: SandboxHold,
  call: ShellCall,
  deadline: number,
  signal: AbortSignal,
): Promise<"ready" | "recycled" | "busy"> {
  const step = bounded(
    clock,
    deadline,
    AbortSignal.any([signal, hold.lost]),
    "the command's time ran out",
  );
  let pass: () => void;
  try {
    pass = await hold.turn(step.signal);
  } catch (error) {
    hold.release();
    signal.throwIfAborted();
    if (hold.lost.aborted) return "recycled";
    if (step.signal.aborted) return "busy";
    throw error;
  } finally {
    step.dispose();
  }
  try {
    if (!hold.lost.aborted)
      return await net.configure(hold, call, deadline, signal);
    hold.release();
    return "recycled";
  } finally {
    pass();
  }
}
