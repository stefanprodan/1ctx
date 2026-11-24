// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Passkeys apart from the browser: the WebAuthn wire's codecs, how long
// options serve, the emailed sign-in's flag and the words for a failed
// add or sign-in.

import {
  type PasskeyAssertion,
  type PasskeyRequestOptions,
  UNKNOWN_PASSKEY,
} from "../../shared/api/access.ts";
import type {
  PasskeyCreationOptions,
  PasskeyRegistration,
} from "../../shared/api/profile.ts";
import { says } from "./format.ts";

export type CreationJSON = PasskeyCreationOptions;
export type RequestJSON = PasskeyRequestOptions;
export type RegistrationJSON = PasskeyRegistration;
export type AssertionJSON = PasskeyAssertion;

type Described = { type: string; id: string; transports?: string[] };

export function toB64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const v of b) text += String.fromCharCode(v);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): ArrayBuffer {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const text = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(text, (c) => c.charCodeAt(0)).buffer;
}

const described = (d: Described) => ({
  type: d.type as "public-key",
  id: fromB64url(d.id),
  ...(d.transports ? { transports: d.transports } : {}),
});

// the bytes create() takes where the answer has base64url
export function creationOf(j: CreationJSON) {
  return {
    ...j,
    challenge: fromB64url(j.challenge),
    user: { ...j.user, id: fromB64url(j.user.id) },
    excludeCredentials: j.excludeCredentials.map(described),
  };
}

export function requestOf(j: RequestJSON) {
  return {
    ...j,
    challenge: fromB64url(j.challenge),
    allowCredentials: (j.allowCredentials as Described[]).map(described),
  };
}

// what create() hands back, as far as the server reads it
export type Attested = {
  id: string;
  rawId: ArrayBuffer;
  toJSON?: () => unknown;
  response: {
    clientDataJSON: ArrayBuffer;
    getAuthenticatorData?: () => ArrayBuffer;
    getPublicKey?: () => ArrayBuffer | null;
    getPublicKeyAlgorithm?: () => number;
    getTransports?: () => string[];
  };
};

export type Asserted = {
  id: string;
  rawId: ArrayBuffer;
  toJSON?: () => unknown;
  response: {
    clientDataJSON: ArrayBuffer;
    authenticatorData: ArrayBuffer;
    signature: ArrayBuffer;
    userHandle: ArrayBuffer | null;
  };
};

// a password manager's own toJSON() may throw or leave fields out
function jsonOf(c: { toJSON?: () => unknown }): Record<string, unknown> {
  try {
    const j = c.toJSON?.() as { response?: unknown } | undefined;
    const r = j?.response;
    return typeof r === "object" && r !== null
      ? (r as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

// the add's answer: toJSON() where the browser has it, each field it
// leaves out from the response's own getters
export function registrationOf(c: Attested): RegistrationJSON {
  const j = jsonOf(c);
  const r = c.response;
  const key = r.getPublicKey?.() ?? null;
  const alg =
    typeof j.publicKeyAlgorithm === "number"
      ? j.publicKeyAlgorithm
      : (r.getPublicKeyAlgorithm?.() ?? 0);
  const transports = Array.isArray(j.transports)
    ? j.transports.filter((t): t is string => typeof t === "string")
    : (r.getTransports?.() ?? []);
  return {
    // the bytes' own form, whatever a password manager put in id
    id: toB64url(c.rawId),
    rawId: toB64url(c.rawId),
    type: "public-key",
    response: {
      clientDataJSON: text(j.clientDataJSON) ?? toB64url(r.clientDataJSON),
      authenticatorData:
        text(j.authenticatorData) ??
        toB64url(r.getAuthenticatorData?.() ?? new ArrayBuffer(0)),
      publicKey: text(j.publicKey) ?? (key === null ? "" : toB64url(key)),
      publicKeyAlgorithm: alg,
      transports,
    },
  };
}

export function assertionOf(c: Asserted): AssertionJSON {
  const r = c.response;
  return {
    // the bytes' own form, whatever a password manager put in id
    id: toB64url(c.rawId),
    rawId: toB64url(c.rawId),
    type: "public-key",
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: r.userHandle === null ? null : toB64url(r.userHandle),
    },
  };
}

// options as the server should answer them: a challenge, a usable
// timeout and the lists the browser reads
export function optionsOk(j: unknown, adding: boolean): boolean {
  if (typeof j !== "object" || j === null) return false;
  const o = j as Record<string, unknown>;
  if (typeof o.challenge !== "string" || o.challenge === "") return false;
  const t = o.timeout;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return false;
  if (!adding) return Array.isArray(o.allowCredentials);
  const user = o.user as Record<string, unknown> | null | undefined;
  return (
    typeof o.rp === "object" &&
    o.rp !== null &&
    typeof user === "object" &&
    user !== null &&
    typeof user.id === "string" &&
    Array.isArray(o.excludeCredentials)
  );
}

// options are used this long before the challenge's end, so the tap and
// the face or finger check still land inside it
export const LEEWAY_MS = 30_000;

const usableFor = (timeout: number) => Math.max(0, timeout - LEEWAY_MS);

export const fresh = (at: number, timeout: number, now: number): boolean =>
  now - at < usableFor(timeout);

// when options fetched at `at` need fetching again
export const refreshIn = (at: number, timeout: number, now: number): number =>
  Math.max(0, at + usableFor(timeout) - now);

// the emailed sign-in's landing carries it once, for the passkey step
const SIGNED_IN = "signed_in";

export function takeSignedIn(search: string): {
  found: boolean;
  search: string;
} {
  const q = new URLSearchParams(search);
  if (!q.has(SIGNED_IN)) return { found: false, search };
  // only the landing's own value asks; any other is dropped all the same
  const found = q.get(SIGNED_IN) === "1";
  q.delete(SIGNED_IN);
  const rest = q.toString();
  return { found, search: rest === "" ? "" : `?${rest}` };
}

const named = (e: unknown): string | null =>
  typeof e === "object" && e !== null && "name" in e
    ? String((e as { name: unknown }).name)
    : null;

// the user closed the browser's sheet, or it timed out
export const cancelled = (e: unknown): boolean => {
  const n = named(e);
  return n === "NotAllowedError" || n === "AbortError";
};

// an answer of this server, as data/api.ts's ApiError carries it
const answered = (e: unknown): e is { status: number; body: unknown } =>
  e instanceof Error && "status" in e && typeof e.status === "number";

// the server holds no such passkey: the browser is asked to forget it
export function unknownPasskey(e: unknown): boolean {
  if (!answered(e)) return false;
  const b = e.body;
  return (
    typeof b === "object" &&
    b !== null &&
    (b as { code?: unknown }).code === UNKNOWN_PASSKEY
  );
}

// a failed add or sign-in in plain words; null for a cancel
export function passkeyWords(e: unknown, adding: boolean): string | null {
  if (cancelled(e)) return null;
  if (unknownPasskey(e)) {
    return "This passkey was removed. Sign in another way.";
  }
  if (answered(e)) return says(e);
  if (named(e) === "InvalidStateError") {
    return "This device already has a passkey.";
  }
  return adding ? "The passkey was not added." : "The passkey did not work.";
}
