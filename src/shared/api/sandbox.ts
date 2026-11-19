// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the sandbox shell's admin routes.

import type {
  LeaseRow,
  SandboxKeyRole,
  SandboxSettings,
  SandboxShell,
} from "../contracts/sandbox.ts";

// GET /api/admin/sandbox, and what PUT answers. keys: whether each of
// the gateway's secret files is present, never its value. active: the
// next command runs in a sandbox (shell sandbox, an endpoint, every key)
export type SandboxResponse = {
  settings: SandboxSettings;
  // the image run when settings.image is null
  defaultImage: string;
  // the sandbox_label a Docker gateway serving this instance must set
  gatewayLabel: string;
  keys: Record<SandboxKeyRole, boolean>;
  active: boolean;
};

// PUT /api/admin/sandbox: fields left out stay. endpoint must be an
// https origin; null takes it off, which the builtin shell allows alone.
// image null runs the default. Shell sandbox needs an endpoint and every
// key file, else a 400
export type PutSandboxRequest = {
  shell?: SandboxShell;
  endpoint?: string | null;
  image?: string | null;
};

// GET /api/admin/sandbox/leases: every sandbox the instance holds,
// stuck ones included, oldest first, and while every command is refused
// (the image failed its root check, a gateway-global policy) why
export type SandboxLeasesResponse = {
  leases: LeaseRow[];
  refused: string | null;
};
