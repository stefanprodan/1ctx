// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a command holds of its workspace's sandbox, and why a sandbox
// goes.

import type { ShellHold } from "../bash/index.ts";

export type RecycleReason =
  | "mounts"
  | "cap"
  | "idle"
  | "clear"
  | "archive"
  | "delete"
  | "fork"
  | "run"
  | "child"
  | "restart"
  | "settings"
  | "failed"
  | "discard";

// a workspace's sandbox, held by one command from acquire to settle
export type SandboxHold = ShellHold & {
  sandbox: string;
  // the sandbox's own process, which the fence spares
  keepAlivePid: number;
  workspace: string;
  // drops the lease and deletes the sandbox, in place of release
  recycle(reason: RecycleReason): void;
};
