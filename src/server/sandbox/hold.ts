// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a command holds of its chat's sandbox, and why a sandbox goes.

import type { ShellHold } from "../bash/index.ts";
import type { Gateway } from "./gateway.ts";

export type RecycleReason =
  | "mounts"
  | "cap"
  | "idle"
  | "clear"
  | "archive"
  | "delete"
  | "run"
  | "restart"
  | "settings"
  | "failed"
  | "discard"
  | "credentials"
  | "network";

// a chat's sandbox, held by each of its commands and its subagents'
// from acquire to settle
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
  // aborted when another holder recycled the sandbox
  lost: AbortSignal;
  // the sandbox's next turn for a push or a save; call what it gives
  // to pass the turn on
  turn(signal: AbortSignal): Promise<() => void>;
  // drops the lease and deletes the sandbox once no command holds it,
  // stopping the others, in place of release
  recycle(reason: RecycleReason): void;
  // the same, in place of release, but the others run on: the sandbox
  // goes once the last of them lets go, and no new command joins it
  retire(reason: RecycleReason): void;
  // an exec found the sandbox not ready or the gateway unavailable;
  // recycle or release still ends the hold
  failed(): void;
};
