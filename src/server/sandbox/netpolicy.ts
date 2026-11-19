// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command's network as OpenShell's policy, pure: the sandbox's own
// network setting and the send's credentials become the sandbox's
// network rules, the providers to attach and the notice naming what was
// left out. Web access never picks its hosts: a send without it
// runs with no network, decided in network.ts. The rules are the proto's init shape, so the gateway port passes them on.

import { createHash, randomBytes } from "node:crypto";
import {
  HTTP_METHODS,
  type HttpMethod,
} from "../../shared/contracts/credential.ts";
import type { SandboxNet } from "../../shared/sandbox-net.ts";
import type { CommandCredential, ShellCall } from "../bash/index.ts";
import { REFUSALS } from "../bash/index.ts";
import {
  envName,
  type Placement,
  type PrefixGlob,
  placement,
  prefixGlob,
  quotable,
} from "./rules.ts";

// OpenShell's NetworkEnforcementMode.ENFORCE: unset is audit, which
// logs a violation and lets it pass
const ENFORCE = 1;
// the wrapper's shell, which covers every process it starts
export const BINARIES = [{ path: "/usr/bin/bash" }];
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
  // the sandbox network it was made from
  mode: SandboxNet["mode"];
  network: Record<string, unknown>;
  // the network as one comparable key
  key: string;
  attach: Attach[];
  // what the command's result names: credentials left out and why
  notice: string;
};

// what a lease's sandbox was last given
export type NetState = {
  // a fresh sandbox's empty policy is off
  mode: SandboxNet["mode"];
  key: string;
  attached: Map<string, { provider: string; hash: string; prefix: string }>;
  // the send whose first command named the notice, and the notice
  noticed: string;
};

export const freshState = (): NetState => ({
  mode: "off",
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

// bun and npm ask for a scoped package as @scope%2fname, and OpenShell
// drops an encoded slash otherwise. Never on a host a credential of the
// send binds, whose prefix check must keep refusing %2F
export const ENCODED_SLASH_HOSTS: readonly string[] = ["registry.npmjs.org"];

const hostEndpoints = (host: string, bound: ReadonlySet<string>) =>
  PORTS.map((port) => ({
    host,
    port,
    protocol: "rest",
    enforcement: ENFORCE,
    rules: allow(HTTP_METHODS, "**"),
    ...(ENCODED_SLASH_HOSTS.includes(host) && !bound.has(host)
      ? { allowEncodedSlash: true }
      : {}),
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
  call: Pick<ShellCall, "credentials">,
  net: SandboxNet,
  instanceId: string,
): NetPlan {
  const rules: Record<string, unknown> = {};
  const attach: Attach[] = [];
  const notes: string[] = [];
  // by code point, so the order never hangs on a locale
  const credentials = [...call.credentials].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  if (net.mode === "hosts") {
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
      rules[`cred_${keyed.name.replace(/-/g, "_")}`] = credentialRule(one);
    }
  }
  const network: Record<string, unknown> = {};
  if (net.mode === "hosts" && net.hosts.length > 0) {
    const bound = new Set(attach.map((one) => one.glob.host));
    network.web = {
      name: "web",
      endpoints: net.hosts.flatMap((host) => hostEndpoints(host, bound)),
      binaries: BINARIES,
    };
  }
  Object.assign(network, rules);
  return {
    mode: net.mode,
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
  if (!quotable(credential.header, credential.template))
    return 'has a header or template with $, `, " or \\, which the shell would read, so it is not attached';
  if (prefixGlob(credential.prefix) === null)
    return "has a prefix the sandbox cannot match, so it is not attached";
  const other = envs.get(envName(credential.name));
  if (other !== undefined)
    return `shares the variable ${envName(credential.name)} with credential ${other}, so it is not attached`;
  return null;
}

// why the sandbox goes, or null. A credential that went, changed its
// key or prefix: an echoed key or an old placeholder may outlive its
// send there. A network turned off: a new sandbox starts with none,
// where a policy load that failed or lagged would leave the old hosts
// open
export function stale(
  state: NetState,
  plan: NetPlan,
): "credentials" | "network" | null {
  const wanted = new Map(plan.attach.map((one) => [one.name, one]));
  for (const [name, had] of state.attached) {
    const want = wanted.get(name);
    if (
      want === undefined ||
      want.provider !== had.provider ||
      want.hash !== had.hash ||
      want.prefix !== had.prefix
    )
      return "credentials";
  }
  return state.mode === "hosts" && plan.mode === "off" ? "network" : null;
}
