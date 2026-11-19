// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command's network as OpenShell's policy, pure: the send's web
// snapshot and credentials become the sandbox's network rules, the
// providers to attach and the notice naming what was left out. The
// rules are the proto's init shape, so the gateway port passes them on.

import { createHash, randomBytes } from "node:crypto";
import {
  HTTP_METHODS,
  type HttpMethod,
} from "../../shared/contracts/credential.ts";
import type { CommandCredential, ShellCall } from "../bash/index.ts";
import { REFUSALS } from "../bash/index.ts";
import {
  envName,
  type Placement,
  type PrefixGlob,
  placement,
  prefixGlob,
} from "./rules.ts";

// OpenShell's NetworkEnforcementMode.ENFORCE: unset is audit, which
// logs a violation and lets it pass
const ENFORCE = 1;
// the wrapper's shell, which covers every process it starts
export const BINARIES = [{ path: "/usr/bin/bash" }];
// every name of three labels or more; OpenShell refuses `*.*` and
// `*.com` as wildcards of a whole top-level domain
export const ALL_HOSTS = "**.*.*";
const PORTS = [443, 80];

// the endpointless profile one credential's provider is made from:
// its variable and where the placeholder may resolve
export type Profile = Placement & {
  id: string;
  env: string;
};

// a credential the sandbox gets as a provider
export type Attach = {
  name: string;
  provider: string;
  profile: Profile;
  key: string;
  // the key's hash, kept in memory to tell a rotation
  hash: string;
  prefix: string;
  glob: PrefixGlob;
  methods: HttpMethod[];
};

export type NetPlan = {
  network: Record<string, unknown>;
  // the network as one comparable key
  key: string;
  attach: Attach[];
  // what the command's result names: credentials left out and why
  notice: string;
};

// what a lease's sandbox was last given
export type NetState = {
  key: string;
  attached: Map<string, { provider: string; hash: string; prefix: string }>;
  // the send whose first command named the notice, and the notice
  noticed: string;
};

export const freshState = (): NetState => ({
  key: JSON.stringify({}),
  attached: new Map(),
  noticed: "",
});

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
// 1ctx- and 14 characters of a hash, as a sandbox's name is shaped
export function hashedName(...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest();
  let tail = "";
  for (const b of digest.subarray(0, 14)) tail += ALPHABET[b % 36];
  return `1ctx-${tail}`;
}

export const keyHash = (key: string) =>
  createHash("sha256").update(key).digest("hex");

const allow = (methods: readonly HttpMethod[], path: string) =>
  methods.map((method) => ({ allow: { method, path } }));

// A provider's name stands for its key too, so a provider's key never
// changes: a rotation or a replaced credential is a new provider, and a
// sandbox still bound to the old one keeps the key its send read. The
// key's hash goes in with a salt of this process alone, so the name
// tells nothing of the key; a restart's names differ, and its sweep
// takes the old ones.
const SALT = randomBytes(32).toString("hex");

const hostEndpoints = (host: string) =>
  PORTS.map((port) => ({
    host,
    port,
    protocol: "rest",
    enforcement: ENFORCE,
    rules: allow(HTTP_METHODS, "**"),
  }));

// the method rules name the bare base too: the endpoint's glob selects
// it, a rule's glob never matches it, and a request there must neither
// fall to another rule on the host nor go unsigned
const rulePaths = (glob: PrefixGlob) => [glob.base, glob.path];

// the credential's own endpoint: its methods allowed under its prefix,
// every other denied, since another rule on the host may allow them and
// a binding checks the place, never the method
function credentialRule(attach: Attach) {
  const { glob } = attach;
  const paths = rulePaths(glob);
  return {
    name: `cred_${attach.name.replace(/-/g, "_")}`,
    endpoints: [
      {
        host: glob.host,
        port: glob.port,
        path: glob.path,
        protocol: "rest",
        enforcement: ENFORCE,
        rules: paths.flatMap((path) => allow(attach.methods, path)),
        denyRules: paths.flatMap((path) =>
          HTTP_METHODS.filter((method) => !attach.methods.includes(method)).map(
            (method) => ({ method, path }),
          ),
        ),
        credentialBinding: { provider: attach.provider },
      },
    ],
    binaries: BINARIES,
  };
}

type Keyed = Extract<CommandCredential, { key: string }>;

export function planNetwork(
  call: Pick<ShellCall, "web" | "credentials">,
  instanceId: string,
): NetPlan {
  const { web } = call;
  const network: Record<string, unknown> = {};
  const attach: Attach[] = [];
  const notes: string[] = [];
  if (web !== null) {
    const hosts = [...(web.mode === "all" ? [ALL_HOSTS] : []), ...web.domains];
    if (hosts.length > 0)
      network.web = {
        name: "web",
        endpoints: hosts.flatMap(hostEndpoints),
        binaries: BINARIES,
      };
  }
  // by code point, so the order never hangs on a locale
  const credentials = [...call.credentials].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  if (web?.mode === "all") {
    if (credentials.length > 0)
      notes.push(
        `credentials are not used while every host is open, so requests go unsigned: ${credentials.map((c) => c.name).join(", ")}\n`,
      );
  } else if (web !== null) {
    const envs = new Map<string, string>();
    for (const credential of credentials) {
      const why = refusal(credential, envs);
      if (why !== null) {
        notes.push(`credential ${credential.name} ${why}\n`);
        continue;
      }
      const keyed = credential as Keyed;
      const where = placement(keyed.header, keyed.template)!;
      const env = envName(keyed.name);
      envs.set(env, keyed.name);
      const profile: Profile = {
        ...where,
        env,
        id: hashedName(instanceId, "profile", env, where.style, where.header),
      };
      const hash = keyHash(keyed.key);
      const one: Attach = {
        name: keyed.name,
        provider: hashedName(
          instanceId,
          "provider",
          keyed.name,
          keyed.prefix,
          profile.id,
          hash,
          SALT,
        ),
        profile,
        key: keyed.key,
        hash,
        prefix: keyed.prefix,
        glob: prefixGlob(keyed.prefix)!,
        methods: [...keyed.methods],
      };
      attach.push(one);
      network[`cred_${keyed.name.replace(/-/g, "_")}`] = credentialRule(one);
    }
  }
  return {
    network,
    key: JSON.stringify(network),
    attach,
    notice: notes.join(""),
  };
}

// a refused credential's words, as the built-in shell's curl names them,
// or why OpenShell cannot place it
function refusal(
  credential: CommandCredential,
  envs: ReadonlyMap<string, string>,
): string | null {
  if ("refused" in credential)
    return `${REFUSALS[credential.refused]}, so it is not attached`;
  if (placement(credential.header, credential.template) === null)
    return `goes in a ${credential.header} header the sandbox cannot fill, so it is not attached`;
  if (prefixGlob(credential.prefix) === null)
    return "has a prefix the sandbox cannot match, so it is not attached";
  const other = envs.get(envName(credential.name));
  if (other !== undefined)
    return `shares the variable ${envName(credential.name)} with credential ${other}, so it is not attached`;
  return null;
}

// a sandbox given a credential that went, changed its key or prefix,
// or a send that left listed mode: an echoed key or an old placeholder
// may outlive its send there, so the sandbox goes
export function stale(state: NetState, plan: NetPlan): boolean {
  const wanted = new Map(plan.attach.map((one) => [one.name, one]));
  for (const [name, had] of state.attached) {
    const want = wanted.get(name);
    if (
      want === undefined ||
      want.provider !== had.provider ||
      want.hash !== had.hash ||
      want.prefix !== had.prefix
    )
      return true;
  }
  return false;
}
