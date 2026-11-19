// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The instance's one sandbox shell setting as a document, applied
// through its admin route. Its row is made with the database, so a
// document only ever updates it; its name is a label.

import type { SandboxResponse } from "../../shared/api/sandbox.ts";
import {
  isGatewayEndpoint,
  isSandboxBackend,
  isSandboxImage,
  isSandboxNetwork,
  SANDBOX_KEYS,
  type SandboxBackend,
  type SandboxNetwork,
} from "../../shared/contracts/sandbox.ts";
import {
  foldDefaults,
  MAX_SANDBOX_HOSTS,
  parseSandboxHosts,
} from "../../shared/sandbox-net.ts";
import type { SecretKind } from "../../shared/words.ts";
import { BadRequest } from "../lib/errors.ts";
import type { Action, Client } from "./client.ts";
import { guarded, optionalSpec } from "./fields.ts";

export type SandboxSpec = {
  backend?: SandboxBackend;
  // null takes it off; the builtin backend alone allows that
  endpoint?: string | null;
  // null runs the default image
  image?: string | null;
  network?: SandboxNetwork;
  // null takes the defaults; stored sorted
  hosts?: string[] | null;
};

function hosts(value: unknown): string[] | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length > MAX_SANDBOX_HOSTS ||
    !value.every((host) => typeof host === "string")
  ) {
    throw new BadRequest(
      `must be null or a list of at most ${MAX_SANDBOX_HOSTS} hosts`,
    );
  }
  const parsed = parseSandboxHosts(value);
  if (!parsed.ok)
    throw new BadRequest(`${JSON.stringify(parsed.value)} ${parsed.error}`);
  // the defaults as null, as the route stores them
  return foldDefaults(parsed.hosts);
}

function orNull<T>(
  guard: (value: unknown) => value is T,
  message: string,
): (value: unknown) => T | null {
  return (value) => {
    if (value !== null && !guard(value)) throw new BadRequest(message);
    return value as T | null;
  };
}

// what the route refuses within one document, before anything is
// written; a field left out is the row's, which only the route reads
export function sandboxSpec(value: unknown): SandboxSpec {
  const spec = optionalSpec<SandboxSpec>(value, {
    backend: guarded(isSandboxBackend, "must be builtin or openshell"),
    endpoint: orNull(
      isGatewayEndpoint,
      "must be null or an https origin (https://host:port)",
    ),
    image: orNull(isSandboxImage, "must be null or an image reference"),
    network: guarded(isSandboxNetwork, "must be off or hosts"),
    hosts,
  });
  if (spec.network === "hosts" && spec.hosts?.length === 0)
    throw new BadRequest("spec.hosts: the hosts network needs a host at least");
  if (spec.backend === "openshell" && spec.endpoint === null)
    throw new BadRequest(
      "spec.endpoint: the sandbox shell needs a gateway endpoint",
    );
  return spec;
}

// offline: the sandbox shell needs the gateway's three key files
export function checkSandbox(
  spec: SandboxSpec,
  readSecret: (field: string, kind: SecretKind, name: string) => string,
): void {
  if (spec.backend !== "openshell") return;
  for (const name of Object.values(SANDBOX_KEYS)) {
    readSecret("backend", "openshell-", name);
  }
}

export async function applySandbox(
  api: Client,
  doc: { spec: SandboxSpec },
): Promise<Action> {
  const held = await api.call<SandboxResponse>("GET", "/api/admin/sandbox");
  const changed: SandboxSpec = {};
  for (const field of [
    "backend",
    "endpoint",
    "image",
    "network",
    "hosts",
  ] as const) {
    const value = doc.spec[field];
    // a list by its sorted hosts, as parsed and as stored
    if (
      value !== undefined &&
      JSON.stringify(value) !== JSON.stringify(held.settings[field])
    ) {
      Object.assign(changed, { [field]: value });
    }
  }
  if (Object.keys(changed).length === 0) return "unchanged";
  await api.call("PUT", "/api/admin/sandbox", changed);
  return "updated";
}
