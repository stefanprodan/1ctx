// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The entry: flags, the db, the secrets, compose(), serve(). The
// wiring itself is in compose.ts so a test can run the same.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import pkg from "../../package.json";
import page from "../client/index.html";
import type { SecretKind } from "../shared/words.ts";
import { TOUCH_AFTER_MS } from "./access/index.ts";
import { type ComposeOptions, compose } from "./compose.ts";
import { httpKeys, MAX_KEY_FILE_BYTES } from "./credentials/index.ts";
import { heldByAnother, inspect, open } from "./db/index.ts";
import { HELP, parseCli } from "./lib/cli.ts";
import { wallClock } from "./lib/clock.ts";
import { logger, scrubErrors, silent } from "./lib/log.ts";
import { shutdownOnSignal } from "./lib/shutdown.ts";
import { loadKnowledge, parse, readSources } from "./provision/index.ts";
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

if (cli.kind === "provision") {
  const { files, dbPath, secretsDir } = cli.options;
  try {
    if (heldByAnother(dbPath)) {
      throw new Error(
        `another process has ${dbPath} open; stop the server before provisioning`,
      );
    }
    const documents = await loadKnowledge(parse(await readSources(files)));
    const store = secrets(
      secretsDir ?? defaultDir(Bun.main, process.execPath),
      "local",
    );
    const options: Omit<ComposeOptions, "db"> = {
      secret: readerOf(store),
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
    const db = open(dbPath).db;
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

const { hostname, port, dbPath, secretsDir, secretsMode } = cli.options;
const { secureCookie, trustProxy } = cli.options;

if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const { db, migrations } = open(dbPath);
const store = secrets(
  secretsDir ?? defaultDir(Bun.main, process.execPath),
  secretsMode,
);
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

const app = await compose({
  db,
  secret: readerOf(store),
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
const flags = [
  ...(secureCookie ? ["secure-cookie"] : []),
  ...(trustProxy ? ["trust-proxy"] : []),
].join(",");
log.info("startup", {
  version: VERSION,
  listen: `http://${server.hostname}:${server.port}`,
  db: displayPath(dbPath),
  secrets: displayPath(store.dir),
  mode: store.mode,
  migrations: migrations.length > 0 ? migrations.join(",") : "current",
  flags: flags || "none",
  providers: app.providers.list().length,
  agents: app.agents.list().length,
  mcp_servers: app.mcp.list().length,
  automations: app.automations.all().length,
  repaired: app.repaired,
  reconciled: app.reconciled,
});

// in order: no more sends, every send ended and its rows written, the
// sockets closed with the restart code, the listener stopped without
// cutting a request, then the db
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  const started = performance.now();
  const result = await app.shutdown();
  await stop();
  db.close();
  log.info("shutdown", {
    signal,
    ended: result.ended,
    duration: performance.now() - started,
    timed_out: result.timedOut || undefined,
  });
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
