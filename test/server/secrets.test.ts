// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secrets } from "../../src/server/secrets/index.ts";
import { isSecretName, SECRET_KINDS } from "../../src/shared/words.ts";
import names from "../fixtures/secrets/names.json";

test.each([...SECRET_KINDS])(
  "the %s guard checks the complete name",
  (kind) => {
    for (const body of names.validBodies) {
      expect(isSecretName(kind, `${kind}${body}`)).toBe(true);
    }
    for (const body of names.invalidBodies) {
      expect(isSecretName(kind, `${kind}${body}`)).toBe(false);
    }
    for (const name of names.wrongNames) {
      expect(isSecretName(kind, name)).toBe(false);
    }
    for (const other of SECRET_KINDS.filter((other) => other !== kind)) {
      expect(isSecretName(kind, `${other}token`)).toBe(false);
    }
    for (const value of [null, undefined, 1, {}, []]) {
      expect(isSecretName(kind, value)).toBe(false);
    }
  },
);

test("unknown and partial kinds are not secret kinds", () => {
  expect(SECRET_KINDS).toEqual([
    "user-",
    "provider-",
    "search-",
    "mcp-",
    "http-",
  ]);
  for (const kind of ["", "user", "webhook-", "unknown-", "provider-a"]) {
    expect(isSecretName(kind, `${kind}token`)).toBe(false);
  }
});

test("secrets refuse invalid and wrong-kind access at the port", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-secrets-"));
  try {
    const valid = SECRET_KINDS.flatMap((kind) =>
      names.validBodies.map((body) => `${kind}${body}`),
    );
    const invalid = [
      ...names.wrongNames,
      ...SECRET_KINDS.flatMap((kind) =>
        names.invalidBodies
          .filter((body) => !body.includes("/"))
          .map((body) => `${kind}${body}`),
      ),
    ];
    for (const name of [...valid, ...invalid]) {
      writeFileSync(join(dir, `${name}.key`), "value\n");
    }
    writeFileSync(join(dir, "provider-notes.txt"), "not a key");
    const store = secrets(dir);
    for (const kind of SECRET_KINDS) {
      const own = valid.filter((name) => name.startsWith(kind)).sort();
      expect(store.list(kind)).toEqual(own);
      for (const name of own) {
        expect(store.read(kind, name)).toBe("value");
      }
      for (const name of [
        ...invalid,
        ...valid.filter((name) => !own.includes(name)),
        `${kind}../outside`,
      ]) {
        expect(() => store.read(kind, name)).toThrow("bad secret name");
        expect(store.list(kind)).not.toContain(name);
      }
    }
    for (const kind of ["", "webhook-", "unknown-", "provider-a"]) {
      expect(() => store.read(kind, `${kind}token`)).toThrow("bad secret name");
      expect(() => store.list(kind)).toThrow("bad secret kind");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read treats an empty file as absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-secrets-"));
  try {
    writeFileSync(join(dir, "provider-empty.key"), " \n\t");
    const store = secrets(dir);
    expect(store.read("provider-", "provider-empty")).toBeNull();
    expect(store.list("provider-")).toEqual(["provider-empty"]);
    writeFileSync(join(dir, "http-large.key"), "k".repeat(20));
    expect(store.read("http-", "http-large", 20)).toBe("k".repeat(20));
    expect(store.read("http-", "http-large", 19)).toBeNull();
    expect(store.read("provider-", "provider-missing")).toBeNull();
    const missing = secrets(join(dir, "absent"));
    expect(missing.list("mcp-")).toEqual([]);
    expect(() => missing.list("webhook-")).toThrow("bad secret kind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read answers null for anything but a regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-secrets-"));
  try {
    mkdirSync(join(dir, "http-folder.key"));
    const made = Bun.spawnSync(["mkfifo", join(dir, "http-pipe.key")]);
    expect(made.exitCode).toBe(0);
    symlinkSync(join(dir, "http-pipe.key"), join(dir, "http-linkpipe.key"));
    writeFileSync(join(dir, "real.txt"), "k".repeat(20));
    symlinkSync(join(dir, "real.txt"), join(dir, "http-linked.key"));
    const store = secrets(dir);
    expect(store.read("http-", "http-folder", 100)).toBeNull();
    expect(store.read("http-", "http-pipe", 100)).toBeNull();
    expect(store.read("http-", "http-linkpipe", 100)).toBeNull();
    expect(store.read("http-", "http-linked", 100)).toBe("k".repeat(20));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// the layout the kubelet writes for a mounted Secret, swapped the way
// it updates one: a new dated folder, then ..data renamed over
test("a Kubernetes Secret mount is read through its links", () => {
  const dir = mkdtempSync(join(tmpdir(), "1ctx-secrets-"));
  try {
    const first = "..2026_10_01_00_00_00.000000001";
    mkdirSync(join(dir, first));
    writeFileSync(join(dir, first, "provider-main.key"), "old\n");
    symlinkSync(first, join(dir, "..data"));
    symlinkSync("..data/provider-main.key", join(dir, "provider-main.key"));
    const store = secrets(dir);
    expect(store.read("provider-", "provider-main")).toBe("old");
    expect(store.list("provider-")).toEqual(["provider-main"]);

    const second = "..2026_10_01_00_05_00.000000002";
    mkdirSync(join(dir, second));
    writeFileSync(join(dir, second, "provider-main.key"), "new\n");
    writeFileSync(join(dir, second, "provider-extra.key"), "added\n");
    symlinkSync(second, join(dir, "..data_tmp"));
    renameSync(join(dir, "..data_tmp"), join(dir, "..data"));
    symlinkSync("..data/provider-extra.key", join(dir, "provider-extra.key"));

    expect(store.read("provider-", "provider-main")).toBe("new");
    expect(store.read("provider-", "provider-extra")).toBe("added");
    expect(store.list("provider-")).toEqual([
      "provider-extra",
      "provider-main",
    ]);
    for (const kind of SECRET_KINDS) {
      for (const name of store.list(kind)) {
        expect(name.startsWith("..")).toBe(false);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
