// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Moves the git and ripgrep pins of deploy/sandbox/base/Dockerfile, its
// four ARG lines, to the newest stable releases: git's highest X.Y.Z
// tarball in kernel.org's sha256sums.asc, its sha256 computed and
// checked against that list, and ripgrep's newest stable crate with
// the checksum crates.io lists. Nothing else in the file changes, and
// nothing when the pins are current. Run by hand (make sandbox-tools)
// or by the shell-base workflow's tools job. With --diff it prints the
// committed pins against the written ones as Markdown, the bump PR's
// body.

import { join } from "node:path";

const DOCKERFILE = join(import.meta.dir, "../deploy/sandbox/base/Dockerfile");
const GIT_DIR = "https://www.kernel.org/pub/software/scm/git";
const CRATE = "https://crates.io/api/v1/crates/ripgrep";
// crates.io refuses a client without one
const HEADERS = { "User-Agent": "1ctx-sandbox-tools" };

export type Pin = { version: string; sha256: string };
export type Pins = { git: Pin; rg: Pin };

const ARGS = {
  git: { version: "GIT_VERSION", sha256: "GIT_SHA256" },
  rg: { version: "RG_VERSION", sha256: "RG_SHA256" },
} as const;

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

const line = (name: string) => new RegExp(`^ARG ${name}=(.*)$`, "gm");

function arg(text: string, name: string, shape: RegExp): string {
  const found = [...text.matchAll(line(name))];
  if (found.length !== 1) {
    throw new Error(`want one ARG ${name}= line, found ${found.length}`);
  }
  const value = found[0][1];
  if (!shape.test(value)) throw new Error(`ARG ${name} is '${value}'`);
  return value;
}

// the four pins a Dockerfile holds
export function readPins(text: string): Pins {
  const pin = (tool: keyof Pins) => ({
    version: arg(text, ARGS[tool].version, VERSION),
    sha256: arg(text, ARGS[tool].sha256, SHA256),
  });
  return { git: pin("git"), rg: pin("rg") };
}

// the Dockerfile with its four ARG lines set to the pins, the rest as is
export function rewrite(text: string, pins: Pins): string {
  let out = text;
  for (const tool of ["git", "rg"] as const) {
    for (const key of ["version", "sha256"] as const) {
      const name = ARGS[tool][key];
      const value = pins[tool][key];
      if (!(key === "version" ? VERSION : SHA256).test(value)) {
        throw new Error(`refusing ${name}=${value}`);
      }
      arg(out, name, key === "version" ? VERSION : SHA256);
      out = out.replace(line(name), `ARG ${name}=${value}`);
    }
  }
  return out;
}

const parts = (v: string) => v.split(".").map(Number);

// below zero when a is older than b
export function compare(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

// kernel.org's signed list as [sha256, file] rows
function rows(list: string): [string, string][] {
  return list.split("\n").flatMap((row) => {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(row.trim());
    return m ? [[m[1], m[2]] as [string, string]] : [];
  });
}

// the sha256 the list gives a file, or null
export function listedSum(list: string, file: string): string | null {
  return rows(list).find(([, name]) => name === file)?.[0] ?? null;
}

export const gitTarball = (version: string) => `git-${version}.tar.xz`;

// the highest X.Y.Z with a tarball in the list, so the version chosen
// is one that can be fetched and checked; a release candidate
// (git-2.57.0.rc1) or any other shape is never stable
export function newestListed(list: string): string | null {
  let best: string | null = null;
  for (const [, file] of rows(list)) {
    const m = /^git-(\d+\.\d+\.\d+)\.tar\.xz$/.exec(file);
    if (m && (best === null || compare(m[1], best) > 0)) best = m[1];
  }
  return best;
}

// git's pin from the tarball's own sha256, only when kernel.org agrees
export function gitPin(version: string, computed: string, list: string): Pin {
  const file = gitTarball(version);
  const listed = listedSum(list, file);
  if (listed === null) throw new Error(`${file} is not in sha256sums.asc`);
  if (listed !== computed) {
    throw new Error(
      `${file} hashes to ${computed}, sha256sums.asc lists ${listed}`,
    );
  }
  return { version, sha256: computed };
}

type Crate = {
  crate?: { max_stable_version?: unknown };
  versions?: { num?: unknown; checksum?: unknown; yanked?: unknown }[];
};

// ripgrep's newest stable version and its crate's checksum
export function cratePin(answer: Crate): Pin {
  const version = answer.crate?.max_stable_version;
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error(`no stable ripgrep version: ${String(version)}`);
  }
  const listed = answer.versions?.find((v) => v.num === version);
  if (listed?.yanked !== false) {
    throw new Error(`ripgrep ${version} is not listed or is yanked`);
  }
  const sha256 = listed.checksum;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    throw new Error(`ripgrep ${version} has no checksum`);
  }
  return { version, sha256 };
}

// the newer of each, so a stale answer never moves a pin back
export function next(current: Pins, found: Partial<Pins>): Pins {
  const pick = (tool: keyof Pins) => {
    const f = found[tool];
    return f && compare(f.version, current[tool].version) > 0
      ? f
      : current[tool];
  };
  return { git: pick("git"), rg: pick("rg") };
}

const NAMES = { git: "git", rg: "ripgrep" } as const;

// the Markdown of what moved; empty when nothing did
export function summary(before: Pins, after: Pins): string {
  const rows = (["git", "rg"] as const)
    .filter((t) => before[t].version !== after[t].version)
    .map((t) => `| ${NAMES[t]} | ${before[t].version} | ${after[t].version} |`);
  if (rows.length === 0) return "";
  return [
    "Bumps the tools the shell base image builds from source (`deploy/sandbox/base/Dockerfile`). git's checksum is its tarball's, matching kernel.org's `sha256sums.asc`; ripgrep's is the one crates.io lists. Its merge publishes a new base.",
    ["| Tool | Was | Now |", "|---|---|---|", ...rows].join("\n"),
  ].join("\n\n");
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
}

async function newestGit(current: Pin): Promise<Pin | undefined> {
  const list = await (await get(`${GIT_DIR}/sha256sums.asc`)).text();
  const version = newestListed(list);
  if (version === null) throw new Error("no stable git in sha256sums.asc");
  if (compare(version, current.version) <= 0) return undefined;
  const file = gitTarball(version);
  const tarball = await (await get(`${GIT_DIR}/${file}`)).arrayBuffer();
  const computed = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
  return gitPin(version, computed, list);
}

if (import.meta.main && Bun.argv.includes("--diff")) {
  const committed = Bun.spawnSync(
    ["git", "show", "HEAD:deploy/sandbox/base/Dockerfile"],
    { cwd: join(import.meta.dir, "..") },
  );
  if (!committed.success) throw new Error("no committed base Dockerfile");
  const before = readPins(committed.stdout.toString());
  const after = readPins(await Bun.file(DOCKERFILE).text());
  const out = summary(before, after);
  if (out) console.log(out);
} else if (import.meta.main) {
  const text = await Bun.file(DOCKERFILE).text();
  const current = readPins(text);
  const [git, rg] = await Promise.all([
    newestGit(current.git),
    get(CRATE).then(async (r) => cratePin((await r.json()) as Crate)),
  ]);
  const pins = next(current, { git, rg });
  const moved = summary(current, pins);
  if (!moved) {
    console.log(
      `pins are current: git ${current.git.version}, ripgrep ${current.rg.version}`,
    );
  } else {
    await Bun.write(DOCKERFILE, rewrite(text, pins));
    console.log(
      `git ${current.git.version} to ${pins.git.version}, ripgrep ${current.rg.version} to ${pins.rg.version}`,
    );
  }
}
