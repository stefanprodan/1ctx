// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The entry: flags, the db, the secrets, compose(), serve(). The
// wiring itself is in compose.ts so a test can run the same.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../../package.json";
import page from "../client/index.html";
import { TOUCH_AFTER_MS } from "./access/index.ts";
import { type ComposeOptions, compose } from "./compose.ts";
import { heldByAnother, inspect, open } from "./db/index.ts";
import { wallClock } from "./lib/clock.ts";
import { logger, silent } from "./lib/log.ts";
import { shutdownOnSignal } from "./lib/shutdown.ts";
import { parse, readSources } from "./provision/index.ts";
import { defaultDir, type SecretsMode, secrets } from "./secrets/index.ts";
import { serve } from "./web/serve.ts";

const buildVersion = process.env.ONECTX_BUILD_VERSION;
export const VERSION = buildVersion || `v${pkg.version}`;

const DEFAULT_LISTEN = "127.0.0.1:1235";
const DEFAULT_DB = join(homedir(), ".1ctx", "1ctx.sqlite");

const HELP = `\x1b[1m1ctx\x1b[0m - one continuous context for agents

\x1b[1mUsage:\x1b[0m
  1ctx [options]
  1ctx provision -f <file|dir|-> [-f ...] [--db <path>] [--secrets <dir>]

\x1b[1mProvision:\x1b[0m
  -f <file|dir|->        YAML file, directory (.yaml/.yml, not recursive),
                         or stdin; repeat to combine inputs
  Apply objects while the server is stopped. No objects are pruned.
  Preflight is offline; applying skills, MCP servers and agents may fetch.

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

function fail(message: string): never {
  console.error(`error: ${message}\n\n${HELP}`);
  process.exit(1);
}

let listen = DEFAULT_LISTEN;
let dbPath = DEFAULT_DB;
let secretsDir: string | null = null;
let secretsMode: SecretsMode = "local";
let secureCookie = false;
let trustProxy = false;

const args = process.argv.slice(2);
const provisioning = args[0] === "provision";
if (provisioning) args.shift();
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) fail(`${arg} needs a value`);
    return v;
  };
  if (
    provisioning &&
    !["-f", "--db", "--secrets", "-v", "--version", "-h", "--help"].includes(
      arg,
    )
  ) {
    fail(`unknown provision option ${arg}`);
  }
  switch (arg) {
    case "-f":
      if (!provisioning) fail("-f is only for provision");
      files.push(next());
      break;
    case "--listen":
      listen = next();
      break;
    case "--db":
      dbPath = next();
      break;
    case "--secrets":
      secretsDir = next();
      break;
    case "--secrets-mode": {
      const v = next();
      if (v !== "local" && v !== "mounted")
        fail("--secrets-mode: local or mounted");
      secretsMode = v;
      break;
    }
    case "--secure-cookie":
      secureCookie = true;
      break;
    case "--trust-proxy":
      trustProxy = true;
      break;
    case "-v":
    case "--version":
      console.log(VERSION);
      process.exit(0);
      break;
    case "-h":
    case "--help":
      console.log(HELP);
      process.exit(0);
      break;
    default:
      fail(`unknown option ${arg}`);
  }
}

if (provisioning && files.length === 0) fail("provision needs -f");

if (provisioning) {
  try {
    if (heldByAnother(dbPath)) {
      throw new Error(
        `another process has ${dbPath} open; stop the server before provisioning`,
      );
    }
    const documents = parse(await readSources(files));
    const store = secrets(
      secretsDir ?? defaultDir(Bun.main, process.execPath),
      secretsMode,
    );
    const options: Omit<ComposeOptions, "db"> = {
      secret: (kind, name) => store.read(kind, name),
      secretNames: (kind) => store.list(kind),
      clock: wallClock,
      log: () => silent,
      version: VERSION,
      secureCookie: false,
      trustProxy: false,
      activate: false,
    };
    const snapshot = inspect(dbPath);
    try {
      const check = await compose({ ...options, db: snapshot });
      try {
        check.provision.validate(documents);
      } finally {
        await check.shutdown();
      }
    } finally {
      snapshot.close();
    }
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    const db = open(dbPath);
    try {
      const app = await compose({ ...options, db });
      try {
        await app.provision.apply(documents);
      } finally {
        await app.shutdown();
      }
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const colon = listen.lastIndexOf(":");
if (colon === -1) fail("--listen must be host:port");
const hostname = listen.slice(0, colon);
const port = Number(listen.slice(colon + 1));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail("--listen port must be 1 to 65535");
}

const log = logger("1ctx");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const db = open(dbPath);
const store = secrets(
  secretsDir ?? defaultDir(Bun.main, process.execPath),
  secretsMode,
);
log(`secrets: ${store.dir} (${store.mode})`);

const app = await compose({
  db,
  secret: (kind, name) => store.read(kind, name),
  secretNames: (kind) => store.list(kind),
  clock: wallClock,
  log: logger,
  version: VERSION,
  secureCookie,
  trustProxy,
});
app.sweep();
app.mcpStart();
setInterval(() => app.sweep(), TOUCH_AFTER_MS);

const { server, stop } = serve({
  hostname,
  port,
  page,
  handle: app.handle,
  socket: app.socket,
  trustProxy,
  development: process.env.ONECTX_DEV === "1",
});
log(`${VERSION} listening on http://${server.hostname}:${server.port}`);

// in order: no more sends, every send ended and its rows written, the
// sockets closed with the restart code, the listener stopped without
// cutting a request, then the db
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  await app.shutdown();
  await stop();
  db.close();
  process.exit(0);
};
const onSignal = (signal: string) => {
  shutdownOnSignal(signal, {
    shutdown,
    log,
    exit: (code) => process.exit(code),
  });
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
