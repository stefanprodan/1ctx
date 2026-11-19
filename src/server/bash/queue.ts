// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One command per workspace at a time, or any number at once for a shell
// that orders its own. A chat or run has its session's workspace; each
// channel agent has a separate one. The held set keeps the idle sweep
// off workspaces with a running or queued command.

import { Queue } from "../lib/queue.ts";
import { type Workspace, workspaceId } from "./workspace.ts";

const workspaces = new Map<string, Queue>();
// the commands running at once in each workspace whose shell allows it
const parallel = new Map<string, number>();

export function heldWorkspaces(): ReadonlySet<string> {
  return new Set([...workspaces.keys(), ...parallel.keys()]);
}

export async function acquireSession(
  workspace: Workspace,
  signal: AbortSignal,
  atOnce = false,
): Promise<() => void> {
  signal.throwIfAborted();
  const id = workspaceId(workspace);
  if (atOnce) {
    parallel.set(id, (parallel.get(id) ?? 0) + 1);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const n = (parallel.get(id) ?? 1) - 1;
      if (n > 0) parallel.set(id, n);
      else parallel.delete(id);
    };
  }
  let queue = workspaces.get(id);
  if (queue === undefined) {
    queue = new Queue(1);
    workspaces.set(id, queue);
  }
  const release = await queue.acquire(signal);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (queue.active === 0) workspaces.delete(id);
  };
}
