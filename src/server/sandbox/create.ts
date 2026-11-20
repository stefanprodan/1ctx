// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One sandbox made: the create, ready, the keep-alive's pid and start
// time, for an image's first sandbox its roots, and its repositories'
// binds, every step on the caller's signal. The image is the lease's.
// A throw leaves the delete to the caller.

import type { ShellRepo, StoredBytes } from "../bash/index.ts";
import type { KnowledgeCaps, SandboxCaps } from "../limits/index.ts";
import { checkBinds } from "./binds.ts";
import type { Lease } from "./book.ts";
import type { Gateway } from "./gateway.ts";
import { readKeepAlive, readStartTime } from "./keepalive.ts";
import type { ImageCheck } from "./roots.ts";
import { createSpec } from "./spec.ts";

export type BuildDeps = {
  gateway: Gateway;
  instanceId: string;
  limits(): KnowledgeCaps & SandboxCaps;
};

export async function buildSandbox(
  deps: BuildDeps,
  check: ImageCheck,
  lease: Lease,
  repos: readonly ShellRepo[],
  stored: StoredBytes | undefined,
  signal: AbortSignal,
): Promise<void> {
  const { gateway } = deps;
  const spec = createSpec({
    name: lease.name,
    instanceId: deps.instanceId,
    image: lease.image,
    caps: deps.limits(),
    repos,
    ...(stored === undefined ? {} : { stored }),
  });
  await gateway.create(spec, signal);
  await gateway.waitReady(lease.name, signal);
  lease.phase = "ready";
  lease.pid = await readKeepAlive(gateway, lease.name, signal);
  lease.started = await readStartTime(gateway, lease.name, lease.pid, signal);
  await check.verify(gateway, lease.name, signal);
  await checkBinds(gateway, lease.name, repos, signal);
}
