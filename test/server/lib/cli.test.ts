// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type Cli,
  optionsToArgs,
  parseCli,
} from "../../../src/server/lib/cli.ts";

const HOME = "/home/u";

function run(argv: string[]) {
  const cli = parseCli(argv, HOME);
  if (cli.kind !== "run") throw new Error(`not a run: ${JSON.stringify(cli)}`);
  return cli.options;
}

function error(argv: string[]): string {
  const cli = parseCli(argv, HOME);
  if (cli.kind !== "error") throw new Error(`no error: ${JSON.stringify(cli)}`);
  return cli.message;
}

describe("parseCli", () => {
  test("no arguments is the server on its defaults", () => {
    expect(run([])).toEqual({
      hostname: "127.0.0.1",
      port: 1235,
      dbPath: "/home/u/.1ctx/1ctx.sqlite",
      secretsDir: null,
      secretsMode: "local",
      secureCookie: false,
      trustProxy: false,
    });
  });

  test("every server option is read", () => {
    expect(
      run([
        "--listen",
        "[::1]:8080",
        "--db",
        "x.sqlite",
        "--secrets",
        "/s",
        "--secrets-mode",
        "mounted",
        "--secure-cookie",
        "--trust-proxy",
      ]),
    ).toEqual({
      hostname: "[::1]",
      port: 8080,
      dbPath: "x.sqlite",
      secretsDir: "/s",
      secretsMode: "mounted",
      secureCookie: true,
      trustProxy: true,
    });
  });

  test("refusals carry the server's words", () => {
    expect(error(["--nope"])).toBe("unknown option --nope");
    expect(error(["--db"])).toBe("--db needs a value");
    expect(error(["--listen", "nohost"])).toBe("--listen must be host:port");
    expect(error(["--listen", "h:0"])).toBe("--listen port must be 1 to 65535");
    expect(error(["--listen", "h:70000"])).toBe(
      "--listen port must be 1 to 65535",
    );
    expect(error(["--secrets-mode", "x"])).toBe(
      "--secrets-mode: local or mounted",
    );
    expect(error(["-f", "a.yaml"])).toBe("-f is only for provision");
  });

  test("version and help win where they stand", () => {
    expect(parseCli(["-v"], HOME)).toEqual({ kind: "version" });
    expect(parseCli(["--db", "x", "--help"], HOME)).toEqual({ kind: "help" });
    expect(error(["--nope", "-v"])).toBe("unknown option --nope");
  });

  test("provision takes files, a db and a secrets directory only", () => {
    expect(
      parseCli(["provision", "-f", "a.yaml", "-f", "-", "--db", "d"], HOME),
    ).toEqual({
      kind: "provision",
      options: { files: ["a.yaml", "-"], dbPath: "d", secretsDir: null },
    } satisfies Cli);
    expect(error(["provision"])).toBe("provision needs -f");
    expect(error(["provision", "--listen", "h:1"])).toBe(
      "unknown provision option --listen",
    );
  });

  test("service hands its arguments on untouched", () => {
    expect(parseCli(["service", "install", "--nope"], HOME)).toEqual({
      kind: "service",
      argv: ["install", "--nope"],
    });
  });
});

describe("optionsToArgs", () => {
  test("the arguments read back as the same options", () => {
    for (const argv of [
      [],
      ["--listen", "0.0.0.0:1235"],
      ["--listen", "[::]:9", "--secrets", "/s", "--secrets-mode", "mounted"],
      ["--db", ":memory:", "--secure-cookie", "--trust-proxy"],
    ]) {
      const options = run(argv);
      expect(run(optionsToArgs(options))).toEqual(options);
    }
  });

  test("the address and the database are always spelled out", () => {
    expect(optionsToArgs(run([]))).toEqual([
      "--listen",
      "127.0.0.1:1235",
      "--db",
      "/home/u/.1ctx/1ctx.sqlite",
    ]);
  });
});
