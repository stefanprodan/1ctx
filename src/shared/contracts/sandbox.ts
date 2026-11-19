// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox shell: the bash tool's commands run in an OpenShell
// sandbox per workspace instead of just-bash, when an admin picks it and
// the gateway is set up. The settings are one row; the gateway's client
// certificate is three secret files, never part of a body.

export const SANDBOX_SHELLS = ["builtin", "sandbox"] as const;
export type SandboxShell = (typeof SANDBOX_SHELLS)[number];
export function isSandboxShell(value: unknown): value is SandboxShell {
  return SANDBOX_SHELLS.some((shell) => shell === value);
}

// where a sandbox's commands may connect: nowhere, or the hosts listed.
// Web access never applies to it
export const SANDBOX_NETWORKS = ["off", "hosts"] as const;
export type SandboxNetwork = (typeof SANDBOX_NETWORKS)[number];
export function isSandboxNetwork(value: unknown): value is SandboxNetwork {
  return SANDBOX_NETWORKS.some((network) => network === value);
}

// the secret files of the gateway's mutual TLS, PEM values, by role
export const SANDBOX_KEYS = {
  ca: "openshell-gateway-ca",
  cert: "openshell-gateway-cert",
  key: "openshell-gateway-key",
} as const;
export type SandboxKeyRole = keyof typeof SANDBOX_KEYS;

export const MAX_GATEWAY_ENDPOINT = 2048;
export const MAX_SANDBOX_IMAGE = 256;

// an https origin (https://host:port) and nothing else: the gateway
// authenticates the caller by its client certificate, so plain http is
// never offered
export function isGatewayEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_GATEWAY_ENDPOINT) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // the origin alone, as the URL writes it: no path, query or login
  return url.protocol === "https:" && value === url.origin;
}

// an OCI reference: registry, path, tag or digest; no spaces or quotes
export function isSandboxImage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SANDBOX_IMAGE &&
    /^[a-z0-9][a-z0-9._/:@-]*[a-z0-9]$/i.test(value)
  );
}

export type SandboxSettings = {
  shell: SandboxShell;
  // null until an admin saves one
  endpoint: string | null;
  // null runs the default image, named after the server's version
  image: string | null;
  network: SandboxNetwork;
  // null until an admin saves a list: the defaults
  hosts: string[] | null;
  // made once with the database; names the gateway's label and every
  // sandbox and provider label
  instanceId: string;
  updatedAt: number;
};

// what a lease's sandbox is doing, for the admin page
export const LEASE_STATES = [
  "creating",
  "warm",
  "leased",
  "idle",
  "deleting",
  "stuck",
] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

export type LeaseRow = {
  // null for a warm sandbox, which no workspace took yet
  workspace: string | null;
  sandbox: string;
  state: LeaseState;
  // the gateway's phase as last seen, null before it was asked
  phase: string | null;
  createdAt: number;
  usedAt: number;
};
