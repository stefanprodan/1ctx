// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The command line, parsed without acting on it: main.ts runs what it
// answers, and `service install` refuses exactly what the server would.

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LISTEN = "127.0.0.1:1235";

export type RunOptions = {
  hostname: string;
  port: number;
  dbPath: string;
  // null is the default directory, which depends on where the binary is
  secretsDir: string | null;
  secretsMode: "local" | "mounted";
  secureCookie: boolean;
  trustProxy: boolean;
};

export type ProvisionOptions = {
  files: string[];
  dbPath: string;
  secretsDir: string | null;
};

export type Cli =
  | { kind: "run"; options: RunOptions }
  | { kind: "provision"; options: ProvisionOptions }
  | { kind: "service"; argv: string[] }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const HELP = `\x1b[1m1ctx\x1b[0m - one continuous context for agents

\x1b[1mUsage:\x1b[0m
  1ctx [options]
  1ctx provision -f <file|dir|-> [-f ...] [--db <path>] [--secrets <dir>]
  1ctx service install [options] [--restart]
  1ctx service status|start|stop|restart
  1ctx service uninstall [--purge]

\x1b[1mProvision:\x1b[0m
  -f <file|dir|->        YAML file, directory (.yaml/.yml, not recursive),
                         or stdin; repeat to combine inputs
  Apply objects while the server is stopped. No objects are pruned.
  Preflight is offline; applying skills, MCP servers and agents may fetch.

\x1b[1mService:\x1b[0m
  install                run 1ctx with these options as a service of the
                         signed-in user, started at login and kept alive;
                         --restart replaces one that is running
  uninstall              remove the service; --purge also removes the
                         database and the log, never the secrets

\x1b[1mOptions:\x1b[0m
  --listen <host:port>   bind address (default: ${DEFAULT_LISTEN})
  --db <path>            SQLite file (default: ~/.1ctx/1ctx.sqlite;
                         ":memory:" keeps nothing)
  --secrets <dir>        the secrets directory (default: ../secrets next to
                         the binary; .preview/secrets from source)
  --secrets-mode <mode>  local (writable from the admin page) or mounted
                         (read-only, a Kubernetes Secret) (default: local)
  --secure-cookie        mark the login cookie Secure; set it when 1ctx is
                         served over TLS
  --trust-proxy          take the client address and scheme from the
                         X-Forwarded-* headers of a proxy in front
  -v, --version          show version
  -h, --help             show this help

\x1b[1mSecrets:\x1b[0m
  user-admin.key         the first admin's password, read once when there
                         are no users; provision also uses it to sign in
  <kind>-<name>.key      kinds: user, provider, search, mcp; the name is
                         1 to 48 lowercase letters, digits and dashes,
                         starting with a letter or a digit`;

const PROVISION_FLAGS = [
  "-f",
  "--db",
  "--secrets",
  "-v",
  "--version",
  "-h",
  "--help",
];

export function defaultDb(home: string): string {
  return join(home, ".1ctx", "1ctx.sqlite");
}

function parseListen(
  listen: string,
): { hostname: string; port: number } | string {
  const colon = listen.lastIndexOf(":");
  if (colon < 1) return "--listen must be host:port";
  const port = Number(listen.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "--listen port must be 1 to 65535";
  }
  return { hostname: listen.slice(0, colon), port };
}

export function parseCli(argv: string[], home: string = homedir()): Cli {
  if (argv[0] === "service") return { kind: "service", argv: argv.slice(1) };
  const provisioning = argv[0] === "provision";
  const args = provisioning ? argv.slice(1) : argv;

  let listen = DEFAULT_LISTEN;
  let dbPath = defaultDb(home);
  let secretsDir: string | null = null;
  let secretsMode: RunOptions["secretsMode"] = "local";
  let secureCookie = false;
  let trustProxy = false;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (provisioning && !PROVISION_FLAGS.includes(arg)) {
      return { kind: "error", message: `unknown provision option ${arg}` };
    }
    const valued = ["-f", "--listen", "--db", "--secrets", "--secrets-mode"];
    let value = "";
    if (valued.includes(arg)) {
      const next = args[++i];
      if (next === undefined) {
        return { kind: "error", message: `${arg} needs a value` };
      }
      value = next;
    }
    switch (arg) {
      case "-f":
        if (!provisioning) {
          return { kind: "error", message: "-f is only for provision" };
        }
        files.push(value);
        break;
      case "--listen":
        listen = value;
        break;
      case "--db":
        if (value === "") return { kind: "error", message: "--db is empty" };
        dbPath = value;
        break;
      case "--secrets":
        secretsDir = value;
        break;
      case "--secrets-mode":
        if (value !== "local" && value !== "mounted") {
          return { kind: "error", message: "--secrets-mode: local or mounted" };
        }
        secretsMode = value;
        break;
      case "--secure-cookie":
        secureCookie = true;
        break;
      case "--trust-proxy":
        trustProxy = true;
        break;
      case "-v":
      case "--version":
        return { kind: "version" };
      case "-h":
      case "--help":
        return { kind: "help" };
      default:
        return { kind: "error", message: `unknown option ${arg}` };
    }
  }

  if (provisioning) {
    if (files.length === 0) {
      return { kind: "error", message: "provision needs -f" };
    }
    return { kind: "provision", options: { files, dbPath, secretsDir } };
  }

  const address = parseListen(listen);
  if (typeof address === "string") return { kind: "error", message: address };
  return {
    kind: "run",
    options: {
      ...address,
      dbPath,
      secretsDir,
      secretsMode,
      secureCookie,
      trustProxy,
    },
  };
}

// The arguments that start a server with these options, every one spelled
// out, so a service definition reads back through parseCli() unchanged.
export function optionsToArgs(options: RunOptions): string[] {
  const host = options.hostname;
  const args = ["--listen", `${host}:${options.port}`, "--db", options.dbPath];
  if (options.secretsDir !== null) args.push("--secrets", options.secretsDir);
  if (options.secretsMode !== "local") {
    args.push("--secrets-mode", options.secretsMode);
  }
  if (options.secureCookie) args.push("--secure-cookie");
  if (options.trustProxy) args.push("--trust-proxy");
  return args;
}
