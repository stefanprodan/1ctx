// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type {
  ServiceBackend,
  ServiceDefinition,
} from "../../../src/server/service/backend.ts";
import {
  runService,
  type ServiceDeps,
  ServiceError,
} from "../../../src/server/service/index.ts";

const HOME = "/home/u";
const BIN = "/home/u/.1ctx/bin/1ctx";

function fake(start: { args?: string[] | null; loaded?: boolean } = {}) {
  const calls: string[] = [];
  const held = { args: start.args ?? null, loaded: start.loaded ?? false };
  let definition: ServiceDefinition | null = null;
  const backend: ServiceBackend = {
    name: "fake.service",
    installed: async () => held.args,
    loaded: async () => held.loaded,
    install: async (next) => {
      calls.push("install");
      definition = next;
      held.args = next.programArguments;
      held.loaded = true;
    },
    start: async () => {
      calls.push("start");
      held.loaded = true;
    },
    stop: async () => {
      calls.push("stop");
      held.loaded = false;
    },
    remove: async () => {
      calls.push("remove");
      held.args = null;
      held.loaded = false;
    },
    state: async () =>
      held.loaded ? { state: "running", pid: 7, program: BIN } : null,
  };
  return { backend, calls, definition: () => definition };
}

function deps(backend: ServiceBackend, more: Partial<ServiceDeps> = {}) {
  const lines: string[] = [];
  const probed: string[] = [];
  const removed: string[] = [];
  const all: ServiceDeps = {
    home: HOME,
    main: "/$bunfs/root/1ctx",
    execPath: BIN,
    cwd: "/work",
    backend,
    write: (line) => lines.push(line),
    sleep: async () => {},
    probe: async (url) => {
      probed.push(url);
      return "v1.2.3";
    },
    remove: async (path) => {
      removed.push(path);
    },
    ...more,
  };
  return { all, lines, probed, removed };
}

describe("service install", () => {
  test("writes the server's options and waits for health", async () => {
    const { backend, definition } = fake();
    const { all, lines, probed } = deps(backend);

    await runService(["install", "--listen", "0.0.0.0:1235"], all);

    expect(definition()).toEqual({
      programArguments: [
        BIN,
        "--listen",
        "0.0.0.0:1235",
        "--db",
        "/home/u/.1ctx/1ctx.sqlite",
      ],
      home: HOME,
      workingDirectory: "/home/u/.1ctx",
      logPath: "/home/u/.1ctx/1ctx.log",
    });
    expect(probed).toEqual(["http://127.0.0.1:1235/api/health"]);
    expect(lines).toEqual(["1ctx v1.2.3 up at http://127.0.0.1:1235"]);
  });

  test("pins a relative path to where it was typed", async () => {
    const { backend, definition } = fake();
    const { all } = deps(backend);

    await runService(
      ["install", "--db", "data/x.sqlite", "--secrets", "keys"],
      all,
    );

    expect(definition()?.programArguments.slice(1)).toEqual([
      "--listen",
      "127.0.0.1:1235",
      "--db",
      "/work/data/x.sqlite",
      "--secrets",
      "/work/keys",
    ]);
  });

  test("refuses what the server would refuse, before touching anything", async () => {
    const { backend, calls } = fake();
    const { all } = deps(backend);

    await expect(runService(["install", "--nope"], all)).rejects.toThrow(
      "unknown option --nope",
    );
    await expect(
      runService(["install", "--listen", "h:0"], all),
    ).rejects.toThrow("--listen port must be 1 to 65535");
    await expect(runService(["install", "-v"], all)).rejects.toThrow(
      "takes the server's options",
    );
    expect(calls).toEqual([]);
  });

  test("--restart is the switch anywhere it cannot be a value", async () => {
    const { backend, calls, definition } = fake({ args: [BIN], loaded: true });
    const { all } = deps(backend);

    await runService(["install", "--restart", "--listen", "h:1"], all);
    await runService(["install", "--listen", "h:1", "--restart"], all);
    expect(calls).toEqual(["install", "install"]);
    // right after --db it is the database's name, and no switch
    await expect(
      runService(["install", "--db", "--restart"], all),
    ).rejects.toThrow("service is running; use install --restart");
    expect(definition()?.programArguments).not.toContain("--restart");
  });

  test("a running service needs --restart", async () => {
    const { backend, calls } = fake({ args: [BIN], loaded: true });
    const { all } = deps(backend);

    await expect(runService(["install"], all)).rejects.toThrow(
      "service is running; use install --restart",
    );
    await runService(["install", "--restart"], all);
    expect(calls).toEqual(["install"]);
  });

  test("needs the compiled binary", async () => {
    const { backend } = fake();
    const { all } = deps(backend, { main: "/repo/src/server/main.ts" });

    await expect(runService(["install"], all)).rejects.toThrow(
      "needs the compiled binary",
    );
  });

  test("a server that never answers is an error", async () => {
    const { backend } = fake();
    const { all } = deps(backend, { probe: async () => null });

    await expect(runService(["install"], all)).rejects.toThrow(
      "1ctx did not answer at http://127.0.0.1:1235",
    );
  });
});

describe("service start, stop, restart", () => {
  const args = [BIN, "--listen", "[::1]:9000", "--db", "/d.sqlite"];

  test("start reads the address from the stored arguments", async () => {
    const { backend, calls } = fake({ args });
    const { all, lines } = deps(backend);

    await runService(["start"], all);

    expect(calls).toEqual(["start"]);
    expect(lines).toEqual(["1ctx v1.2.3 up at http://[::1]:9000"]);
  });

  test("start refuses when nothing is installed or it already runs", async () => {
    await expect(
      runService(["start"], deps(fake().backend).all),
    ).rejects.toThrow("service is not installed");
    await expect(
      runService(["start"], deps(fake({ args, loaded: true }).backend).all),
    ).rejects.toThrow("service is already running");
  });

  test("restart stops, then starts", async () => {
    const { backend, calls } = fake({ args, loaded: true });

    await runService(["restart"], deps(backend).all);

    expect(calls).toEqual(["stop", "start"]);
  });

  test("stop names the service", async () => {
    const { backend } = fake({ args, loaded: true });
    const { all, lines } = deps(backend);

    await runService(["stop"], all);

    expect(lines).toEqual(["stopped fake.service"]);
  });

  test("stored arguments the server would refuse are an error", async () => {
    const { backend } = fake({ args: [BIN, "--gone"] });

    await expect(runService(["start"], deps(backend).all)).rejects.toThrow(
      "service definition is invalid",
    );
  });
});

describe("service status", () => {
  test("running", async () => {
    const { backend } = fake({
      args: [BIN, "--listen", "0.0.0.0:1235"],
      loaded: true,
    });
    const { all, lines } = deps(backend);

    await runService(["status"], all);

    expect(lines[0].split("\n")).toEqual([
      "service: fake.service",
      "state: running",
      "pid: 7",
      `binary: ${BIN}`,
      "version: v1.2.3",
      "url: http://127.0.0.1:1235",
    ]);
  });

  test("stopped asks no server", async () => {
    const { backend } = fake({ args: [BIN] });
    const { all, lines, probed } = deps(backend);

    await runService(["status"], all);

    expect(lines[0]).toContain("state: stopped");
    expect(lines[0]).toContain("version: -");
    expect(probed).toEqual([]);
  });

  test("not installed", async () => {
    const { all, lines } = deps(fake().backend);

    await runService(["status"], all);

    expect(lines[0]).toContain("state: not installed");
    expect(lines[0]).toContain("url: -");
  });
});

describe("service uninstall", () => {
  const args = [BIN, "--db", "/data/x.sqlite"];

  test("keeps the data", async () => {
    const { backend, calls } = fake({ args, loaded: true });
    const { all, lines, removed } = deps(backend);

    await runService(["uninstall"], all);

    expect(calls).toEqual(["remove"]);
    expect(removed).toEqual([]);
    expect(lines).toEqual(["uninstalled fake.service"]);
  });

  test("--purge refuses a definition it cannot read", async () => {
    const { backend, calls } = fake({ args: [BIN, "--gone"] });
    const { all, removed } = deps(backend);

    await expect(runService(["uninstall", "--purge"], all)).rejects.toThrow(
      "uninstall without --purge",
    );
    expect(calls).toEqual([]);
    expect(removed).toEqual([]);
    await runService(["uninstall"], all);
    expect(calls).toEqual(["remove"]);
  });

  test("--purge removes the database and the log, never the secrets", async () => {
    const { backend } = fake({ args });
    const { all, removed } = deps(backend);

    await runService(["uninstall", "--purge"], all);

    expect(removed).toEqual([
      "/data/x.sqlite",
      "/data/x.sqlite-shm",
      "/data/x.sqlite-wal",
      "/home/u/.1ctx/1ctx.log",
      "/home/u/.1ctx/1ctx.log.1",
    ]);
  });
});

describe("service command line", () => {
  test("anything else is the usage", async () => {
    const { all } = deps(fake().backend);
    for (const argv of [
      [],
      ["nope"],
      ["status", "x"],
      ["uninstall", "--all"],
    ]) {
      await expect(runService(argv, all)).rejects.toThrow(
        "usage: 1ctx service",
      );
    }
  });

  test("a platform without a backend says so", async () => {
    await expect(
      runService(["status"], { home: HOME, platform: "linux" }),
    ).rejects.toThrow("service is not supported on linux yet");
  });

  test("a backend failure is a service error with its words", async () => {
    const { backend } = fake({ args: [BIN], loaded: true });
    backend.stop = async () => {
      throw new Error("launchctl bootout: Operation not permitted");
    };

    const failed = runService(["stop"], deps(backend).all);

    await expect(failed).rejects.toBeInstanceOf(ServiceError);
    await expect(failed).rejects.toThrow("Operation not permitted");
  });
});
