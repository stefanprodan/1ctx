// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fetch curl calls in a mount with network. The request curl asked
// for picks its fetch once: a URL under a credential's prefix goes
// through that credential's own fetch, whose one allow-list entry is the
// prefix and signs every hop, or is refused; any other URL goes through
// the web fetch, which never signs. So a redirect off a prefix is
// refused rather than sent unsigned, and one into a prefix from an
// unsigned request stays unsigned. Every key the command read is
// replaced in what comes back, and in any error, before curl sees it.

import {
  createSecureFetch,
  type FetchResult,
  matchesAllowListEntry,
  NetworkAccessDeniedError,
  type NetworkConfig,
  type SecureFetch,
} from "just-bash";
import type { HttpMethod } from "../../shared/contracts/credential.ts";
import { urlPrefixes, type WebSnapshot } from "../../shared/web.ts";

const ALL_METHODS: HttpMethod[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
];

// why a credential signs nothing in this command
export type Refusal = "off" | "missing" | "unusable" | "deleted";

// one credential of the send as a command sees it: the key read for this
// command, or why it signs nothing. The key rides here and nowhere else
export type CommandCredential = { name: string; prefix: string } & (
  | { key: string; header: string; value: string; methods: HttpMethod[] }
  | { refused: Refusal }
);

export type FetchLimits = { timeoutMs: number; maxResponseSize: number };

const REFUSALS: Record<Refusal, string> = {
  off: "is off in this chat",
  missing: "has no key",
  unusable: "has an unusable key",
  deleted: "was removed",
};

export function webNetwork(
  web: WebSnapshot,
  limits: FetchLimits,
): NetworkConfig {
  return {
    ...(web.mode === "all"
      ? { dangerouslyAllowFullInternetAccess: true }
      : {
          allowedUrlPrefixes: urlPrefixes(web.domains),
          allowedMethods: ALL_METHODS,
        }),
    // Bun cannot pin DNS, so a private-range check would fail closed
    denyPrivateRanges: false,
    timeoutMs: limits.timeoutMs,
    maxResponseSize: limits.maxResponseSize,
  };
}

type Secret = { key: string; label: string };

function secretsOf(credentials: readonly CommandCredential[]): Secret[] {
  return credentials
    .flatMap((credential) =>
      "key" in credential
        ? [{ key: credential.key, label: `[credential ${credential.name}]` }]
        : [],
    )
    .sort((a, b) => b.key.length - a.key.length);
}

// the longest key first, so a key inside another never leaves a part of
// the longer one
export function redactText(text: string, secrets: readonly Secret[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret.key).join(secret.label);
  return out;
}

const encoder = new TextEncoder();

function replaceBytes(
  bytes: Uint8Array,
  needle: Uint8Array,
  label: Uint8Array,
): Uint8Array {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = buffer.indexOf(needle);
  if (at === -1) return bytes;
  const parts: Uint8Array[] = [];
  let from = 0;
  while (at !== -1) {
    parts.push(bytes.subarray(from, at), label);
    from = at + needle.byteLength;
    at = buffer.indexOf(needle, from);
  }
  parts.push(bytes.subarray(from));
  return Buffer.concat(parts);
}

export function redactResult(
  result: FetchResult,
  secrets: readonly Secret[],
  maxResponseSize: number,
): FetchResult {
  if (secrets.length === 0) return result;
  let body = result.body;
  for (const secret of secrets) {
    body = replaceBytes(
      body,
      encoder.encode(secret.key),
      encoder.encode(secret.label),
    );
  }
  if (body !== result.body && body.byteLength > maxResponseSize) {
    throw new Error(`Response body too large (max: ${maxResponseSize} bytes)`);
  }
  const headers: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(result.headers)) {
    const folded = name.toLowerCase();
    if (secrets.some((secret) => folded.includes(secret.key.toLowerCase()))) {
      continue;
    }
    headers[name] = redactText(value, secrets);
  }
  if (body !== result.body) headers["content-length"] = String(body.byteLength);
  return {
    status: result.status,
    statusText: redactText(result.statusText, secrets),
    headers,
    body,
    url: redactText(result.url, secrets),
  };
}

// a command's text with every key it read replaced
export const scrubKeys = (
  text: string,
  credentials: readonly CommandCredential[],
): string => redactText(text, secretsOf(credentials));

// an error of the fetch rebuilt from its first line, the keys replaced;
// curl reads only its message
export function rebuildError(
  error: unknown,
  secrets: readonly Secret[],
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const rebuilt = new Error(
    redactText(message.split("\n", 1)[0] ?? "", secrets),
  );
  if (error instanceof Error) rebuilt.name = error.name;
  return rebuilt;
}

// the fetch the mount hands curl; building it opens nothing, each inner
// fetch is made on the first request that needs it
export function commandFetch(
  web: WebSnapshot,
  credentials: readonly CommandCredential[],
  limits: FetchLimits,
): SecureFetch {
  const secrets = secretsOf(credentials);
  let webFetch: SecureFetch | undefined;
  const signed = new Map<string, SecureFetch>();
  const signedFetch = (
    credential: Extract<CommandCredential, { key: string }>,
  ): SecureFetch => {
    let made = signed.get(credential.name);
    if (made === undefined) {
      made = createSecureFetch({
        allowedUrlPrefixes: [
          {
            url: credential.prefix,
            transform: [{ headers: { [credential.header]: credential.value } }],
          },
        ],
        allowedMethods: credential.methods,
        denyPrivateRanges: false,
        timeoutMs: limits.timeoutMs,
        maxResponseSize: limits.maxResponseSize,
      });
      signed.set(credential.name, made);
    }
    return made;
  };
  return async (url, options = {}) => {
    try {
      const credential = credentials.find((entry) =>
        matchesAllowListEntry(url, entry.prefix),
      );
      let result: FetchResult;
      if (credential === undefined) {
        webFetch ??= createSecureFetch(webNetwork(web, limits));
        result = await webFetch(url, options);
      } else if ("refused" in credential) {
        throw new NetworkAccessDeniedError(
          url,
          `credential ${credential.name} ${REFUSALS[credential.refused]}`,
        );
      } else {
        const method = (options.method ?? "GET").toUpperCase();
        if (!credential.methods.includes(method as HttpMethod)) {
          throw new Error(
            `HTTP method '${method}' not allowed by credential ${credential.name}. Allowed methods: ${credential.methods.join(", ")}`,
          );
        }
        result = await signedFetch(credential)(url, options);
      }
      return redactResult(result, secrets, limits.maxResponseSize);
    } catch (error) {
      throw rebuildError(error, secrets);
    }
  };
}
