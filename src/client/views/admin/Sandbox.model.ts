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
  type SandboxSettings,
  type SandboxShell,
} from "../../../shared/contracts/sandbox.ts";
import { ago } from "../../lib/format.ts";

// what the form holds: text as typed, empty for none
export type SandboxDraft = {
  shell: SandboxShell;
  endpoint: string;
  image: string;
};

export type SandboxField = keyof SandboxDraft;

export const SHELL_OPTIONS: { value: SandboxShell; label: string }[] = [
  { value: "builtin", label: "Built-in" },
  { value: "sandbox", label: "Sandbox" },
];

export function draftOf(settings: SandboxSettings): SandboxDraft {
  return {
    shell: settings.shell,
    endpoint: settings.endpoint ?? "",
    image: settings.image ?? "",
  };
}

export function sandboxBody(
  d: SandboxDraft,
): { body: PutSandboxRequest } | { field: SandboxField; error: string } {
  const endpoint = d.endpoint.trim();
  const image = d.image.trim();
  if (endpoint === "" && d.shell === "sandbox") {
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
      shell: d.shell,
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
  [/^shell must be /, "shell"],
  [/^endpoint must be /, "endpoint"],
  [/^image must be /, "image"],
  [/^the sandbox shell needs a gateway endpoint$/, "endpoint"],
  [/^the sandbox shell needs openshell-/, "shell"],
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

export function shellLine(state: SandboxResponse): string {
  return state.active
    ? "Commands run in an OpenShell sandbox, one per chat or run."
    : "Commands run in the built-in shell, inside the server.";
}

// why the saved sandbox shell is not running, null while it runs or
// the built-in one is picked
export function offLine(state: SandboxResponse): string | null {
  if (state.settings.shell !== "sandbox" || state.active) return null;
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
