// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How a credential reaches a sandbox, pure, so the bash tool's
// description and the policy name the same variable, header and path.

import { KEY_PLACEHOLDER } from "../../shared/contracts/credential.ts";

// the variable that holds a credential's placeholder in every command
export const envName = (name: string) =>
  `ONECTX_CRED_${name.toUpperCase().replace(/-/g, "_")}`;

// Where OpenShell may resolve the placeholder: an Authorization value
// with any words around it (bearer style), or another header that holds
// the placeholder alone. A Cookie is never rewritten, and a template
// with words around the key in another header never resolves.
export type Placement = { style: "bearer" | "header"; header: string };

export function placement(header: string, template: string): Placement | null {
  const folded = header.toLowerCase();
  if (folded === "authorization")
    return { style: "bearer", header: "authorization" };
  if (folded === "cookie" || folded === "set-cookie") return null;
  return template === KEY_PLACEHOLDER
    ? { style: "header", header: folded }
    : null;
}

// The description quotes the header in double quotes, so the variable
// expands; a `$`, backtick, `"` or `\` of its own would expand or end
// them, and such a credential is not attached.
export const quotable = (header: string, template: string) =>
  !/[$`"\\]/.test(header + template.replace(KEY_PLACEHOLDER, ""));

// the header value the agent sends, the variable in the key's place
export const placeholderValue = (template: string, name: string) =>
  template.replace(KEY_PLACEHOLDER, () => `$${envName(name)}`);

// A credential prefix as OpenShell's endpoint: its host, port, the
// endpoint's path glob (`/v1/` as `/v1/**`, which OpenShell's endpoint
// selector matches at `/v1` too) and the bare base (`/v1`), which a
// rule's `/v1/**` never matches, so the method rules name both. Null
// when the path holds a glob character, which would widen it, or an
// escape, which OpenShell refuses, and when the host is a pattern or an
// IPv6 literal, which OpenShell would read as a host glob or refuse.
export type PrefixGlob = {
  host: string;
  port: number;
  path: string;
  base: string;
};

export function prefixGlob(prefix: string): PrefixGlob | null {
  const url = URL.parse(prefix);
  if (url === null || url.protocol !== "https:") return null;
  if (!/^[a-z0-9._-]+$/.test(url.hostname)) return null;
  const path = url.pathname;
  if (/[*?[\]{}\\%]/.test(path)) return null;
  const base = path.endsWith("/") ? path.slice(0, -1) : path;
  return {
    host: url.hostname,
    port: url.port === "" ? 443 : Number(url.port),
    path: `${base}/**`,
    base: base === "" ? "/" : base,
  };
}
