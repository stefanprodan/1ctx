// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// `1ctx service`: the binary installs itself with the platform's service
// manager. The commands here know no platform; the backend does.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { optionsToArgs, parseCli, type RunOptions } from "../lib/cli.ts";
import type { ServiceBackend } from "./backend.ts";
import { launchdBackend } from "./launchd.ts";

const HEALTH_ATTEMPTS = 60;
const USAGE = "usage: 1ctx service install|status|start|stop|restart|uninstall";

export class ServiceError extends Error {}

export type ServiceDeps = {
  home?: string;
  // Bun.main and the running executable: a service runs the compiled
  // binary, never the source
  main?: string;
  execPath?: string;
  cwd?: string;
  platform?: string;
  backend?: ServiceBackend;
  write?: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  // the version a server at this url answers, null when none does
  probe?: (url: string) => Promise<string | null>;
  remove?: (path: string) => Promise<void>;
};

async function healthProbe(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

function backendFor(platform: string, home: string): ServiceBackend {
  if (platform === "darwin") return launchdBackend({ home });
  throw new ServiceError(`service is not supported on ${platform} yet`);
}

function resolveDeps(deps: ServiceDeps) {
  const home = deps.home ?? homedir();
  return {
    home,
    main: deps.main ?? Bun.main,
    execPath: deps.execPath ?? process.execPath,
    cwd: deps.cwd ?? process.cwd(),
    backend:
      deps.backend ?? backendFor(deps.platform ?? process.platform, home),
    write: deps.write ?? ((line: string) => console.log(line)),
    sleep:
      deps.sleep ??
      ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
    probe: deps.probe ?? healthProbe,
    remove:
      deps.remove ??
      (async (path: string) => {
        await Bun.file(path)
          .delete()
          .catch(() => undefined);
      }),
  };
}

type Resolved = ReturnType<typeof resolveDeps>;

function logPath(home: string): string {
  return join(home, ".1ctx", "1ctx.log");
}

function optionsOf(args: string[], home: string): RunOptions | null {
  const cli = parseCli(args, home);
  return cli.kind === "run" ? cli.options : null;
}

// where a client on this machine reaches the server
function urlOf(options: RunOptions): string {
  let host = options.hostname;
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    host = "127.0.0.1";
  } else if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${options.port}`;
}

async function waitForHealth(url: string, r: Resolved): Promise<void> {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
    const version = await r.probe(`${url}/api/health`);
    if (version !== null) {
      r.write(`1ctx ${version} up at ${url}`);
      return;
    }
    await r.sleep(1_000);
  }
  throw new ServiceError(`1ctx did not answer at ${url}`);
}

async function stored(r: Resolved): Promise<RunOptions> {
  const args = await r.backend.installed();
  if (args === null) throw new ServiceError("service is not installed");
  const options = optionsOf(args.slice(1), r.home);
  if (options === null) throw new ServiceError("service definition is invalid");
  return options;
}

async function install(argv: string[], r: Resolved): Promise<void> {
  if (r.main.endsWith(".ts")) {
    throw new ServiceError("service install needs the compiled binary");
  }
  const restart = argv.includes("--restart");
  const cli = parseCli(
    argv.filter((argument) => argument !== "--restart"),
    r.home,
  );
  if (cli.kind === "error") throw new ServiceError(cli.message);
  if (cli.kind !== "run") {
    throw new ServiceError("service install takes the server's options");
  }
  // the service starts in ~/.1ctx, so a relative path is pinned to where
  // it was typed
  const pin = (path: string) =>
    isAbsolute(path) ? path : resolve(r.cwd, path);
  const options: RunOptions = {
    ...cli.options,
    dbPath:
      cli.options.dbPath === ":memory:" ? ":memory:" : pin(cli.options.dbPath),
    secretsDir:
      cli.options.secretsDir === null ? null : pin(cli.options.secretsDir),
  };
  if ((await r.backend.loaded()) && !restart) {
    throw new ServiceError("service is running; use install --restart");
  }
  await r.backend.install({
    programArguments: [r.execPath, ...optionsToArgs(options)],
    home: r.home,
    workingDirectory: join(r.home, ".1ctx"),
    logPath: logPath(r.home),
  });
  await waitForHealth(urlOf(options), r);
}

async function start(r: Resolved): Promise<void> {
  const options = await stored(r);
  if (await r.backend.loaded()) {
    throw new ServiceError("service is already running");
  }
  await r.backend.start();
  await waitForHealth(urlOf(options), r);
}

async function restart(r: Resolved): Promise<void> {
  const options = await stored(r);
  await r.backend.stop();
  await r.backend.start();
  await waitForHealth(urlOf(options), r);
}

async function status(r: Resolved): Promise<void> {
  const args = await r.backend.installed();
  const options = args === null ? null : optionsOf(args.slice(1), r.home);
  const state = await r.backend.state();
  const url = options === null ? null : urlOf(options);
  const version =
    state !== null && url !== null ? await r.probe(`${url}/api/health`) : null;
  const fallback = args === null ? "not installed" : "stopped";
  r.write(
    [
      `service: ${r.backend.name}`,
      `state: ${state?.state ?? fallback}`,
      `pid: ${state?.pid ?? "-"}`,
      `binary: ${state?.program ?? args?.[0] ?? "-"}`,
      `version: ${version ?? "-"}`,
      `url: ${url ?? "-"}`,
    ].join("\n"),
  );
}

async function uninstall(purge: boolean, r: Resolved): Promise<void> {
  const args = await r.backend.installed();
  const options = args === null ? null : optionsOf(args.slice(1), r.home);
  await r.backend.remove();
  if (purge) {
    const db = options?.dbPath ?? join(r.home, ".1ctx", "1ctx.sqlite");
    const log = logPath(r.home);
    const paths = db === ":memory:" ? [] : [db, `${db}-shm`, `${db}-wal`];
    for (const path of [...paths, log, `${log}.1`]) await r.remove(path);
  }
  r.write(`uninstalled ${r.backend.name}${purge ? " and purged data" : ""}`);
}

export async function runService(
  argv: string[],
  deps: ServiceDeps = {},
): Promise<void> {
  const [command, ...rest] = argv;
  const known = ["install", "status", "start", "stop", "restart", "uninstall"];
  if (command === undefined || !known.includes(command)) {
    throw new ServiceError(USAGE);
  }
  const r = resolveDeps(deps);
  try {
    if (command === "install") return await install(rest, r);
    if (command === "uninstall") {
      if (rest.length === 0) return await uninstall(false, r);
      if (rest.length === 1 && rest[0] === "--purge") {
        return await uninstall(true, r);
      }
      throw new ServiceError(USAGE);
    }
    if (rest.length > 0) throw new ServiceError(USAGE);
    if (command === "status") return await status(r);
    if (command === "start") return await start(r);
    if (command === "restart") return await restart(r);
    await r.backend.stop();
    r.write(`stopped ${r.backend.name}`);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    // the manager's own words: a launchctl failure, a file it could not write
    throw new ServiceError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
