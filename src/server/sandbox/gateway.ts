// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The port to an OpenShell gateway: what the sandbox area asks of it,
// in its own shapes, so the leases and the backend never see the SDK's
// types and a test runs them over a fake. Every call takes a signal; a
// caller bounds a step by aborting it at its deadline.

// the gateway's phase of one sandbox, folded to what 1ctx acts on;
// gone: the gateway does not know the name
export type SandboxPhase =
  | "provisioning"
  | "ready"
  | "error"
  | "deleting"
  | "stopped"
  | "other"
  | "gone";

// a writable root: a tmpfs sized from its cap, so a full one answers
// "No space left on device" and Docker Desktop's writable layer, which
// has no limit, is never written. exec: programs may run from it
export type TmpfsMount = {
  type: "tmpfs";
  target: string;
  sizeBytes: number;
  exec: boolean;
};
// a repository's cached tree, read-only
export type BindMount = { type: "bind"; source: string; target: string };

// the create-time policy: the filesystem and Landlock, fixed for the
// sandbox's life; network rules are a later setPolicy's
export type SandboxPolicy = {
  readOnly: string[];
  readWrite: string[];
};

export type CreateSpec = {
  name: string;
  labels: Record<string, string>;
  image: string;
  // the sandbox's canonical process, which keeps it running
  command: string[];
  cpus: number;
  memoryMiB: number;
  policy: SandboxPolicy;
  mounts: (TmpfsMount | BindMount)[];
};

export type ExecRequest = {
  sandbox: string;
  command: string[];
  stdin?: Uint8Array;
  workdir?: string;
  environment?: Record<string, string>;
  signal: AbortSignal;
};

// stdout and stderr as they arrive, then the exit; a stream that ends
// without an exit throws
export type ExecEvent =
  | { stream: "stdout" | "stderr"; data: Uint8Array }
  | { exit: number };

export type SandboxInfo = {
  name: string;
  phase: SandboxPhase;
  labels: Record<string, string>;
};

export type Gateway = {
  // healthy, or a throw when it cannot be reached
  health(signal: AbortSignal): Promise<{ healthy: boolean; version: string }>;
  // a gateway-global policy replaces every sandbox's own, so the sandbox
  // shell refuses to run while one is set
  globalPolicy(signal: AbortSignal): Promise<boolean>;
  create(spec: CreateSpec, signal: AbortSignal): Promise<void>;
  // until the sandbox is ready; a throw for an error or stopped phase
  waitReady(name: string, signal: AbortSignal): Promise<void>;
  // one launch, never retried: a fresh request id makes a lost
  // transport fail rather than run the command twice
  exec(request: ExecRequest): AsyncIterable<ExecEvent>;
  // accepted or already absent; the delete itself goes on in the gateway
  delete(name: string, signal: AbortSignal): Promise<void>;
  // until the gateway no longer knows the name
  waitDeleted(name: string, signal: AbortSignal): Promise<void>;
  phase(name: string, signal: AbortSignal): Promise<SandboxPhase>;
  // the sandboxes carrying every label given
  list(
    labels: Record<string, string>,
    signal: AbortSignal,
  ): Promise<SandboxInfo[]>;
  // the create-time policy again with new network rules, which alone
  // may change; waited for until the sandbox reports this version
  // loaded, not only saved. A load error throws with its words
  setPolicy(
    name: string,
    policy: SandboxPolicy,
    network: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void>;
  providers: {
    list(
      labels: Record<string, string>,
      signal: AbortSignal,
    ): Promise<string[]>;
    delete(name: string, signal: AbortSignal): Promise<void>;
  };
  close(): void;
};

// what a gateway is reached with: the endpoint and its mutual TLS, PEM
export type GatewayConfig = {
  endpoint: string;
  ca: string;
  cert: string;
  key: string;
};

export type Connect = (config: GatewayConfig) => Gateway;

// an exec the gateway refused because the sandbox is not ready or the
// gateway is unavailable: the lease goes, not only the command
export class SandboxUnavailable extends Error {
  override name = "SandboxUnavailable";
}
