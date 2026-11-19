// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a command holds of its workspace's sandbox, and why a sandbox
// goes.

import type { ShellHold } from "../bash/index.ts";
import type { Gateway } from "./gateway.ts";

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
  | "discard"
  | "credentials"
  | "network";

// a workspace's sandbox, held by one command from acquire to settle
export type SandboxHold = ShellHold & {
  sandbox: string;
  // the sandbox's own process, which the fence spares
  keepAlivePid: number;
  keepAliveStart: string;
  workspace: string;
  // the gateway that made it, which every exec of a command goes to
  gateway: Gateway;
  // the backend's record of what the sandbox holds, kept with the lease
  synced: { value: unknown };
  // what network.ts last gave the sandbox, kept with the lease
  network: { value: unknown };
  // what the network leaves out, named in this command's result
  notice: string;
  // drops the lease and deletes the sandbox, in place of release
  recycle(reason: RecycleReason): void;
  // an exec found the sandbox not ready or the gateway unavailable;
  // recycle or release still ends the hold
  failed(): void;
};
