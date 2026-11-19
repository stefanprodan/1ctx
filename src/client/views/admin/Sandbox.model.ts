// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  PutSandboxRequest,
  SandboxResponse,
} from "../../../shared/api/sandbox.ts";
import {
  isGatewayEndpoint,
  isSandboxImage,
  type LeaseRow,
  type LeaseState,
  SANDBOX_KEYS,
  type SandboxBackend,
  type SandboxNetwork,
  type SandboxSettings,
} from "../../../shared/contracts/sandbox.ts";
import {
  foldDefaults,
  MAX_SANDBOX_HOSTS,
  parseSandboxHosts,
  SANDBOX_DEFAULT_HOSTS,
} from "../../../shared/sandbox-net.ts";
import { ago } from "../../lib/format.ts";
import { hostsCount, lineError } from "./Tools.model.ts";

// what the form holds: text as typed, empty for none
export type SandboxDraft = {
  backend: SandboxBackend;
  endpoint: string;
  image: string;
};

export type SandboxField = keyof SandboxDraft;

export const BACKEND_OPTIONS: { value: SandboxBackend; label: string }[] = [
  { value: "builtin", label: "Built-in" },
  { value: "openshell", label: "OpenShell" },
];

export function draftOf(settings: SandboxSettings): SandboxDraft {
  return {
    backend: settings.backend,
    endpoint: settings.endpoint ?? "",
    image: settings.image ?? "",
  };
}

export function sandboxBody(
  d: SandboxDraft,
): { body: PutSandboxRequest } | { field: SandboxField; error: string } {
  const endpoint = d.endpoint.trim();
  const image = d.image.trim();
  if (endpoint === "" && d.backend === "openshell") {
    return { field: "endpoint", error: "Enter the gateway's address" };
  }
  if (endpoint !== "" && !isGatewayEndpoint(endpoint)) {
    return {
      field: "endpoint",
      error: "An https address, as https://host:port",
    };
  }
  if (image !== "" && !isSandboxImage(image)) {
    return { field: "image", error: "Not an image reference" };
  }
  return {
    body: {
      backend: d.backend,
      endpoint: endpoint === "" ? null : endpoint,
      image: image === "" ? null : image,
    },
  };
}

export function sandboxDirty(d: SandboxDraft, settings: SandboxSettings) {
  const saved = draftOf(settings);
  return (Object.keys(saved) as SandboxField[]).some(
    (field) => d[field].trim() !== saved[field],
  );
}

// the server's whole phrases, so a changed message changes these
const FIELDS: [RegExp, SandboxField][] = [
  [/^backend must be /, "backend"],
  [/^endpoint must be /, "endpoint"],
  [/^image must be /, "image"],
  [/^the sandbox shell needs a gateway endpoint$/, "endpoint"],
  [/^the sandbox shell needs openshell-/, "backend"],
];

export function sandboxFieldOf(message: string): SandboxField | undefined {
  return FIELDS.find(([words]) => words.test(message))?.[1];
}

export const keyFiles = () =>
  Object.values(SANDBOX_KEYS).map((name) => `${name}.key`);

export function missingKeys(state: SandboxResponse): string[] {
  return (Object.keys(SANDBOX_KEYS) as (keyof typeof SANDBOX_KEYS)[])
    .filter((role) => !state.keys[role])
    .map((role) => `${SANDBOX_KEYS[role]}.key`);
}

// the shell picked, saved or not; offLine says when a saved sandbox
// shell does not run
export function backendLine(backend: SandboxBackend): string {
  return backend === "openshell"
    ? "Commands run in an OpenShell sandbox, one per chat or run."
    : "Commands run in the built-in shell, inside the server.";
}

// why the saved sandbox shell is not running, null while it runs or
// the built-in one is picked
export function offLine(state: SandboxResponse): string | null {
  if (state.settings.backend !== "openshell" || state.active) return null;
  const missing = missingKeys(state);
  if (missing.length === 0) return null;
  return `The sandbox shell is off: ${missing.join(", ")} ${
    missing.length === 1 ? "is" : "are"
  } missing.`;
}

// the server's words for why no command runs
export const refusedLine = (refused: string) =>
  `Every command is refused: ${refused}.`;

const STATE_WORDS: Record<LeaseState, string> = {
  creating: "Creating",
  warm: "Warm",
  leased: "Running",
  idle: "Idle",
  deleting: "Deleting",
  stuck: "Stuck",
};

export const leaseWord = (state: LeaseState) => STATE_WORDS[state];

// who it serves and what the gateway last said of it
export function leaseSub(row: LeaseRow): string {
  const who = row.workspace ?? "No chat yet";
  return row.phase === null ? who : `${who} · ${row.phase}`;
}

export const leaseAge = (row: LeaseRow, now: number) =>
  `made ${ago(row.createdAt, now)}`;

// a stuck delete's next step, from the phase the gateway reports
export function stuckLine(row: LeaseRow): string | null {
  if (row.state !== "stuck") return null;
  return row.phase === "error"
    ? "Its delete did not finish. Remove its containers and volumes on the Docker host."
    : "Its delete did not finish. It counts against the cap.";
}

export function leaseCounts(rows: readonly LeaseRow[]) {
  const of = (...states: LeaseState[]) =>
    rows.filter((r) => states.includes(r.state)).length;
  return {
    inUse: of("leased", "idle"),
    warm: of("creating", "warm"),
    stuck: of("stuck"),
  };
}

// the Network card's form: the mode and the hosts box as typed
export type NetDraft = { mode: SandboxNetwork; text: string };

export const NETWORK_OPTIONS: { value: SandboxNetwork; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "hosts", label: "Hosts" },
];

export const NETWORK_LINE =
  "Where commands in the sandbox may connect, while Web access is on.";

export const HOSTS_HINT =
  "One host per line. A wildcard needs three labels, like *.example.com.";

const hostsText = (hosts: readonly string[]) => hosts.join("\n");
const DEFAULTS_TEXT = hostsText(SANDBOX_DEFAULT_HOSTS);

// the saved hosts, or the defaults while none are saved
export function netDraftOf(settings: SandboxSettings): NetDraft {
  return {
    mode: settings.network,
    text: hostsText(settings.hosts ?? SANDBOX_DEFAULT_HOSTS),
  };
}

export const NET_DEFAULTS: NetDraft = { mode: "hosts", text: DEFAULTS_TEXT };

// the hosts the box parses to, sorted, or null when it does not parse
function hostsOf(text: string): string[] | null {
  const parsed = parseSandboxHosts(text.split("\n"));
  return parsed.ok ? parsed.hosts : null;
}

// Use defaults has nothing to do: hosts, and the box holds the defaults
// in any order
export function netAtDefaults(d: NetDraft): boolean {
  return d.mode === "hosts" && hostsOf(d.text)?.join("\n") === DEFAULTS_TEXT;
}

// off keeps the list without reading it
export function netDirty(d: NetDraft, settings: SandboxSettings): boolean {
  const saved = netDraftOf(settings);
  if (d.mode !== saved.mode) return true;
  return d.mode === "hosts" && d.text.trim() !== saved.text;
}

// the defaults go as null, so a later release's defaults reach this one
export function netBody(
  d: NetDraft,
): { body: PutSandboxRequest } | { error: string } {
  if (d.mode === "off") return { body: { network: "off" } };
  const parsed = parseSandboxHosts(d.text.split("\n"));
  if (!parsed.ok) return { error: lineError(parsed) };
  if (parsed.hosts.length === 0) return { error: "List at least one host." };
  return { body: { network: "hosts", hosts: foldDefaults(parsed.hosts) } };
}

// the lines typed while the box does not parse
export function netCount(text: string): string {
  const parsed = hostsOf(text);
  return `${parsed === null ? hostsCount(text) : parsed.length} of ${MAX_SANDBOX_HOSTS}`;
}

// as tall as what is typed, within reason; past that it scrolls
export const netRows = (text: string) =>
  Math.min(Math.max(text.split("\n").length, 4) + 1, 16);

export function netFieldOf(message: string): "hosts" | undefined {
  return /^hosts|^network must be |^the hosts network /.test(message)
    ? "hosts"
    : undefined;
}
