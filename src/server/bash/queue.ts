// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One command per workspace at a time. A chat or run has its session's
// workspace; each channel agent has a separate one. The held set keeps the
// idle sweep off workspaces with a running or queued command.

import { Queue } from "../lib/queue.ts";
import { type Workspace, workspaceId } from "./workspace.ts";

const workspaces = new Map<string, Queue>();

export function heldWorkspaces(): ReadonlySet<string> {
  return new Set(workspaces.keys());
}

export async function acquireSession(
  workspace: Workspace,
  signal: AbortSignal,
): Promise<() => void> {
  signal.throwIfAborted();
  const id = workspaceId(workspace);
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
