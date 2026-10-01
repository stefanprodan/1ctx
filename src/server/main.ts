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
import type { SecretKind } from "../shared/words.ts";
import { TOUCH_AFTER_MS } from "./access/index.ts";
import { compose } from "./compose.ts";
import { httpKeys, MAX_KEY_FILE_BYTES } from "./credentials/index.ts";
import { type Db, open } from "./db/index.ts";
import { HELP, parseCli } from "./lib/cli.ts";
import { wallClock } from "./lib/clock.ts";
import {
  errorFields,
  type LogFactory,
  logger,
  scrubErrors,
  silent,
} from "./lib/log.ts";
import { shutdownOnSignal } from "./lib/shutdown.ts";
import { type ProvisionResult, provisionPaths } from "./provision/index.ts";
import { defaultDir, type Secrets, secrets } from "./secrets/index.ts";
import { runService, ServiceError } from "./service/index.ts";
import { serve } from "./web/serve.ts";

const buildVersion = process.env.ONECTX_BUILD_VERSION;
export const VERSION = buildVersion || `v${pkg.version}`;

function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function fail(message: string): never {
  console.error(`error: ${message}\n\n${HELP}`);
  process.exit(1);
}

const cli = parseCli(process.argv.slice(2));

// an http- file is sized before it is read, and one past a key's room
// is never read
function readerOf(store: Secrets) {
  return (kind: SecretKind, name: string) =>
    store.read(kind, name, kind === "http-" ? MAX_KEY_FILE_BYTES : undefined);
}
if (cli.kind === "error") fail(cli.message);
if (cli.kind === "version") {
  console.log(VERSION);
  process.exit(0);
}
if (cli.kind === "help") {
  console.log(HELP);
  process.exit(0);
}

if (cli.kind === "service") {
  try {
    await runService(cli.argv);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// an app that only provisions and starts nothing
function provisioner(store: Secrets, log: LogFactory = () => silent) {
  return (db: Db) =>
    compose({
      db,
      secret: readerOf(store),
      secretNames: (kind) => store.list(kind),
      clock: wallClock,
      log,
      version: VERSION,
      secureCookie: false,
      trustProxy: false,
      activate: false,
    });
}

if (cli.kind === "provision") {
  const { files, dbPath, secretsDir } = cli.options;
  try {
    const store = secrets(secretsDir ?? defaultDir(Bun.main, process.execPath));
    await provisionPaths({
      paths: files,
      dbPath,
      compose: provisioner(store),
      output: console.log,
    });
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const { hostname, port, dbPath, secretsDir, cacheDir, provision } = cli.options;
const { secureCookie, trustProxy, drain } = cli.options;

const store = secrets(secretsDir ?? defaultDir(Bun.main, process.execPath));
const keys = httpKeys({
  secret: readerOf(store),
  secretNames: (kind) => store.list(kind),
});
const log = scrubErrors(logger("1ctx"), () =>
  (["provider-", "search-", "mcp-", "http-"] as const).flatMap((kind) =>
    store.list(kind).flatMap((name) => {
      const value = keys.scrubbed(kind, name);
      return value === null ? [] : [value];
    }),
  ),
);

// applied before the server opens the db, so nothing it caches is stale
let provisioned: ProvisionResult | null = null;
if (provision.length > 0) {
  try {
    provisioned = await provisionPaths({
      paths: provision,
      dbPath,
      // the first admin's creation is still said; the router's request
      // lines for each applied object are not
      compose: provisioner(store, (area) =>
        area === "users" ? logger(area) : silent,
      ),
      optional: true,
    });
  } catch (error) {
    log.error("provision failed", errorFields(error));
    process.exit(1);
  }
}

if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const opened = open(dbPath);
const db = opened.db;
const migrations = [...(provisioned?.migrations ?? []), ...opened.migrations];
// zeros when a path was given and held nothing to apply
const applied =
  provision.length > 0
    ? (provisioned?.counts ?? { created: 0, updated: 0, unchanged: 0 })
    : undefined;

const app = await compose({
  db,
  secret: readerOf(store),
  secretNames: (kind) => store.list(kind),
  clock: wallClock,
  log: logger,
  version: VERSION,
  secureCookie,
  trustProxy,
  drainMs: drain * 1000,
  // an in-memory database keeps no cache either
  cacheDir:
    cacheDir ?? (dbPath === ":memory:" ? null : join(dirname(dbPath), "repos")),
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
const flags = [
  ...(secureCookie ? ["secure-cookie"] : []),
  ...(trustProxy ? ["trust-proxy"] : []),
].join(",");
log.info("startup", {
  version: VERSION,
  listen: `http://${server.hostname}:${server.port}`,
  db: displayPath(dbPath),
  secrets: displayPath(store.dir),
  cache: app.repoCache === null ? "none" : displayPath(app.repoCache.dir),
  cache_trees: app.repoCache?.trees,
  cache_bytes: app.repoCache?.bytes,
  migrations: migrations.length > 0 ? migrations.join(",") : "current",
  provision:
    provision.length > 0 ? provision.map(displayPath).join(",") : undefined,
  provision_created: applied?.created,
  provision_updated: applied?.updated,
  provision_unchanged: applied?.unchanged,
  flags: flags || "none",
  drain,
  providers: app.providers.list().length,
  agents: app.agents.list().length,
  mcp_servers: app.mcp.list().length,
  automations: app.automations.all().length,
  repaired: app.repaired,
  reconciled: app.reconciled,
});

// in order: no more sends, the running ones drained, what is left
// ended and its rows written, the sockets closed with the restart code,
// the listener stopped without cutting a request, then the db
const onSignal = shutdownOnSignal({
  async shutdown(signal, cut) {
    const started = performance.now();
    const result = await app.shutdown(cut);
    await stop();
    db.close();
    log.info("shutdown", {
      signal,
      drained: result.drained,
      ended: result.ended,
      duration: performance.now() - started,
      timed_out: result.timedOut || undefined,
    });
    process.exit(0);
  },
  log,
  exit: (code) => process.exit(code),
});
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
