// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cluster's mint step against a fake kubectl: the order of its
// cleanup on every ending, and no token on the disk.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cancelled, type Kube, mint } from "../../../scripts/load/pods.ts";
import { tempDirs } from "../../helpers/temp.ts";

const temp = tempDirs();

// logs each call, keeps what it read on stdin, and answers the reads the
// mint step and the rollout make
const FAKE = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
case "$*" in
  *"/dev/stdin"*) n=$(wc -l < "$dir/calls" | tr -d " "); cat > "$dir/stdin-$n"; echo "kind: x" ;;
  *"apply -f -"*) cat > /dev/null ;;
  *"get pod mint-logins"*) cat "$dir/phase" ;;
  *"logs mint-logins"*) echo "minted 3 logins" ;;
  *"get deploy onectx"*) printf '2 2 1 1 1 ' ;;
  *"get pods -o json"*) echo '{"items":[]}' ;;
esac
`;

function fake(phase: string) {
  const dir = temp("load-pods-");
  writeFileSync(join(dir, "kubectl"), FAKE);
  writeFileSync(join(dir, "phase"), phase);
  const calls = () =>
    readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  return {
    dir,
    calls,
    k: (...args: string[]) => ["sh", join(dir, "kubectl"), ...args],
  };
}

const kube = (k: Kube["k"], cancelled = () => false): Kube => ({
  k,
  sleep: async () => {},
  cancelled,
});

// the index of the first call holding all the words
const at = (calls: string[], ...words: string[]) =>
  calls.findIndex((c) => words.every((w) => c.includes(w)));

describe("the mint step", () => {
  test("hands the tokens to kubectl on stdin, never a file", async () => {
    const f = fake("Succeeded");
    await mint(kube(f.k), ["admin", "u001"], "1ctx-load", "bun:x");
    const stdins = readdirSync(f.dir).filter((n) => n.startsWith("stdin-"));
    const read = stdins.map((n) => readFileSync(join(f.dir, n), "utf8"));
    const tokens = read.find((t) => !/^\{"admin":"[0-9a-f]{64}"/.test(t))!;
    expect(Object.keys(JSON.parse(tokens))).toEqual(["admin", "u001"]);
    expect(
      at(f.calls(), "create", "secret", "load-logins", "/dev/stdin"),
    ).toBeGreaterThan(-1);
    expect(
      readdirSync(f.dir).filter(
        (n) => !/^(kubectl|phase|calls|stdin-\d+)$/.test(n),
      ),
    ).toEqual([]);
  });

  test("a failed mint deletes its pod before the server scales back", async () => {
    const f = fake("Failed");
    await expect(
      mint(kube(f.k), ["admin"], "1ctx-load", "bun:x"),
    ).rejects.toThrow("minting logins: minted 3 logins");
    const calls = f.calls();
    const down = at(calls, "scale", "--replicas=0");
    const removed = calls.findLastIndex((c) =>
      c.includes("delete pod mint-logins"),
    );
    const up = at(calls, "scale", "--replicas=1");
    expect(down).toBeGreaterThan(-1);
    expect(removed).toBeGreaterThan(down);
    expect(up).toBeGreaterThan(removed);
  });

  test("a cancel runs the same cleanup", async () => {
    const f = fake("Running");
    let polls = 0;
    await expect(
      mint(
        kube(f.k, () => polls++ > 0),
        ["admin"],
        "1ctx-load",
        "bun:x",
      ),
    ).rejects.toBeInstanceOf(Cancelled);
    const calls = f.calls();
    const removed = calls.findLastIndex((c) =>
      c.includes("delete pod mint-logins"),
    );
    expect(at(calls, "apply")).toBeGreaterThan(-1);
    expect(at(calls, "scale", "--replicas=1")).toBeGreaterThan(removed);
  });

  test("a success waits for the server's rollout", async () => {
    const f = fake("Succeeded");
    await mint(kube(f.k), ["admin"], "1ctx-load", "bun:x");
    const calls = f.calls();
    expect(at(calls, "get deploy onectx")).toBeGreaterThan(
      at(calls, "scale", "--replicas=1"),
    );
  });
});
