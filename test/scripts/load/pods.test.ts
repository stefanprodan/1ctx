// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The cluster's mint step against a fake kubectl: the order of its
// cleanup on every ending, and no token on the disk.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Cancelled,
  type Kube,
  mint,
  RecoveryFailed,
} from "../../../scripts/load/pods.ts";
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
  *"scale deploy/onectx --replicas=0"*) if [ -f "$dir/fail-scale" ]; then exit 130; fi ;;
  *"delete pod mint-logins"*)
    n=$(grep -c "delete pod mint-logins" "$dir/calls")
    f=$(cat "$dir/delete-fails" 2>/dev/null || echo 0)
    if [ "$n" -gt 1 ] && [ "$n" -le $((1 + f)) ]; then echo "delete refused" >&2; exit 1; fi ;;
  *"get pod mint-logins"*) cat "$dir/phase" ;;
  *"logs mint-logins"*) echo "minted 3 logins" ;;
  *"get deploy onectx"*) printf '2 2 1 1 1 ' ;;
  *"get pods -o json"*) echo '{"items":[]}' ;;
esac
`;

function fake(
  phase: string,
  o: { failScale?: boolean; deleteFails?: number } = {},
) {
  const dir = temp("load-pods-");
  writeFileSync(join(dir, "kubectl"), FAKE);
  writeFileSync(join(dir, "phase"), phase);
  if (o.failScale) writeFileSync(join(dir, "fail-scale"), "");
  writeFileSync(join(dir, "delete-fails"), String(o.deleteFails ?? 0));
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
        (n) => !/^(kubectl|phase|calls|delete-fails|stdin-\d+)$/.test(n),
      ),
    ).toEqual([]);
  });

  // the mint pod deleted after the last scale-down, then one replica,
  // then the rollout read
  const restored = (calls: string[]) => {
    const removed = calls.findLastIndex((c) =>
      c.includes("delete pod mint-logins"),
    );
    const up = calls.findLastIndex((c) => c.includes("--replicas=1"));
    const rollout = calls.findLastIndex((c) => c.includes("get deploy onectx"));
    expect(removed).toBeGreaterThan(at(calls, "--replicas=0"));
    expect(up).toBeGreaterThan(removed);
    expect(rollout).toBeGreaterThan(up);
  };

  test("a success restores the server", async () => {
    const f = fake("Succeeded");
    await mint(kube(f.k), ["admin"], "1ctx-load", "bun:x");
    restored(f.calls());
  });

  test("a failed mint restores the server", async () => {
    const f = fake("Failed");
    await expect(
      mint(kube(f.k), ["admin"], "1ctx-load", "bun:x"),
    ).rejects.toThrow("minting logins: minted 3 logins");
    restored(f.calls());
  });

  test("a scale-down cut short restores the server", async () => {
    const f = fake("Succeeded", { failScale: true });
    await expect(
      mint(kube(f.k), ["admin"], "1ctx-load", "bun:x"),
    ).rejects.toThrow("scale deploy/onectx");
    restored(f.calls());
    expect(at(f.calls(), "apply")).toBeLessThan(at(f.calls(), "--replicas=0"));
  });

  test("a cancel during the mint wait restores the server", async () => {
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
    restored(f.calls());
  });

  test("a final delete that fails once is tried again", async () => {
    const f = fake("Succeeded", { deleteFails: 1 });
    await mint(kube(f.k), ["admin"], "1ctx-load", "bun:x");
    restored(f.calls());
  });

  test("a mint pod that will not go leaves the server down and says so", async () => {
    const f = fake("Failed", { deleteFails: 2 });
    const done = mint(kube(f.k), ["admin"], "1ctx-load", "bun:x");
    await expect(done).rejects.toBeInstanceOf(RecoveryFailed);
    await expect(done).rejects.toThrow(
      /not restored: .*delete refused.*after: minting logins/,
    );
    expect(at(f.calls(), "--replicas=1")).toBe(-1);
  });
});
