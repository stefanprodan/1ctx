// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The instance's one sandbox shell setting as a document, applied
// through its admin route. Its row is made with the database, so a
// document only ever updates it; its name is a label.

import type { SandboxResponse } from "../../shared/api/sandbox.ts";
import {
  isGatewayEndpoint,
  isSandboxImage,
  isSandboxShell,
  SANDBOX_KEYS,
  type SandboxShell,
} from "../../shared/contracts/sandbox.ts";
import type { SecretKind } from "../../shared/words.ts";
import { BadRequest } from "../lib/errors.ts";
import type { Action, Client } from "./client.ts";
import { guarded, optionalSpec } from "./fields.ts";

export type SandboxSpec = {
  shell?: SandboxShell;
  // null takes it off; the builtin shell alone allows that
  endpoint?: string | null;
  // null runs the default image
  image?: string | null;
};

function orNull<T>(
  guard: (value: unknown) => value is T,
  message: string,
): (value: unknown) => T | null {
  return (value) => {
    if (value !== null && !guard(value)) throw new BadRequest(message);
    return value as T | null;
  };
}

export function sandboxSpec(value: unknown): SandboxSpec {
  return optionalSpec<SandboxSpec>(value, {
    shell: guarded(isSandboxShell, "must be builtin or sandbox"),
    endpoint: orNull(
      isGatewayEndpoint,
      "must be null or an https origin (https://host:port)",
    ),
    image: orNull(isSandboxImage, "must be null or an image reference"),
  });
}

// offline: the sandbox shell needs the gateway's three key files
export function checkSandbox(
  spec: SandboxSpec,
  readSecret: (field: string, kind: SecretKind, name: string) => string,
): void {
  if (spec.shell !== "sandbox") return;
  for (const name of Object.values(SANDBOX_KEYS)) {
    readSecret("shell", "openshell-", name);
  }
}

export async function applySandbox(
  api: Client,
  doc: { spec: SandboxSpec },
): Promise<Action> {
  const held = await api.call<SandboxResponse>("GET", "/api/admin/sandbox");
  const changed: SandboxSpec = {};
  for (const field of ["shell", "endpoint", "image"] as const) {
    const value = doc.spec[field];
    if (value !== undefined && value !== held.settings[field]) {
      Object.assign(changed, { [field]: value });
    }
  }
  if (Object.keys(changed).length === 0) return "unchanged";
  await api.call("PUT", "/api/admin/sandbox", changed);
  return "updated";
}
