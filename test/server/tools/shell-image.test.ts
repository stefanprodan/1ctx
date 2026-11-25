// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox image's two Dockerfiles: the variants copy onto the
// published base and run nothing on the target platform, and the
// README beside them names every package and pin they hold.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_VARIANTS } from "../../../src/shared/contracts/sandbox.ts";

const DIR = join(import.meta.dir, "..", "..", "..", "deploy", "sandbox");
const VARIANTS = readFileSync(join(DIR, "Dockerfile"), "utf8");
const BASE = readFileSync(join(DIR, "base", "Dockerfile"), "utf8");
const README = readFileSync(join(DIR, "README.md"), "utf8");

type Stage = {
  name: string;
  from: string;
  platform: string | null;
  // each instruction on one line, continuations joined
  instructions: string[];
};

function stagesOf(dockerfile: string): Stage[] {
  const lines = dockerfile
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const stages: Stage[] = [];
  for (const line of lines) {
    const from =
      /^FROM\s+(?:--platform=(\S+)\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (from !== null) {
      stages.push({
        name: from[3] ?? String(stages.length),
        from: from[2]!,
        platform: from[1] ?? null,
        instructions: [],
      });
    } else {
      stages.at(-1)?.instructions.push(line);
    }
  }
  return stages;
}

// the image a stage starts from, through the stages it names
function rootOf(stages: Stage[], name: string): string | null {
  const seen = new Set<string>();
  let stage = stages.find((s) => s.name === name);
  while (stage !== undefined && !seen.has(stage.name)) {
    seen.add(stage.name);
    const from = stage.from;
    const parent = stages.find((s) => s.name === from);
    if (parent === undefined) return from;
    stage = parent;
  }
  return null;
}

// the stages with a RUN that would run on the target platform
const targetRuns = (stages: Stage[]): string[] =>
  stages
    .filter((s) => s.instructions.some((i) => /^RUN\s/i.test(i)))
    .filter((s) => s.platform !== "$BUILDPLATFORM")
    .map((s) => s.name);

// the packages a stage's apt-get install lines name
const aptPackages = (stage: Stage): string[] =>
  stage.instructions.flatMap((i) =>
    [...i.matchAll(/apt-get install((?:\s+-\S+)*)\s+([^&|;]+)/g)].flatMap((m) =>
      m[2]!.trim().split(/\s+/),
    ),
  );

const PINNED_BASE =
  /^ghcr\.io\/stefanprodan\/1ctx-shell-base:[\w.-]+@sha256:[a-f0-9]{64}$/;

const pin = (text: string, pattern: RegExp): string => {
  const found = pattern.exec(text);
  if (found === null) throw new Error(`no pin ${pattern}`);
  return found[1]!;
};

// the README's table row whose first cell starts with name
const row = (readme: string, name: string): string[] | undefined =>
  readme
    .split("\n")
    .filter((line) => line.startsWith(`| ${name}`))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )[0];

describe("the Dockerfiles' parse", () => {
  const FIXTURE = [
    "FROM --platform=$BUILDPLATFORM alpine:3 AS links",
    "RUN ln -s a b \\",
    " && true",
    "FROM ghcr.io/x/base:t@sha256:1 AS base",
    "FROM base AS one",
    "COPY --from=links /b /b",
    "FROM base AS two",
    "RUN apt-get install -y --no-install-recommends \\",
    "      gcc make \\",
    " && rm -rf /var/lib/apt/lists/*",
  ].join("\n");

  test("a stage holds its instructions, continuations joined", () => {
    const stages = stagesOf(FIXTURE);
    expect(stages.map((s) => [s.name, s.from, s.platform])).toEqual([
      ["links", "alpine:3", "$BUILDPLATFORM"],
      ["base", "ghcr.io/x/base:t@sha256:1", null],
      ["one", "base", null],
      ["two", "base", null],
    ]);
    expect(stages[0]!.instructions).toEqual(["RUN ln -s a b   && true"]);
    expect(rootOf(stages, "one")).toBe("ghcr.io/x/base:t@sha256:1");
  });

  test("a RUN outside a build platform stage is found", () => {
    expect(targetRuns(stagesOf(FIXTURE))).toEqual(["two"]);
  });

  test("apt-get install names its packages", () => {
    const stages = stagesOf(FIXTURE);
    expect(aptPackages(stages[3]!)).toEqual(["gcc", "make"]);
    expect(aptPackages(stages[0]!)).toEqual([]);
  });
});

describe("the variants Dockerfile", () => {
  const stages = stagesOf(VARIANTS);

  test("each variant is a target on the base pinned by tag and digest", () => {
    for (const variant of SANDBOX_VARIANTS) {
      expect(stages.map((s) => s.name)).toContain(variant);
      expect(rootOf(stages, variant) ?? "", variant).toMatch(PINNED_BASE);
    }
  });

  test("no RUN runs on the target platform", () => {
    expect(targetRuns(stages)).toEqual([]);
  });

  test("its Rust is the base's ripgrep build's", () => {
    const rust = /^FROM (rust:\S+) AS/m;
    expect(pin(VARIANTS, rust)).toBe(pin(BASE, rust));
  });
});

describe("the README", () => {
  const base = stagesOf(BASE);
  const shipped = ["base", "cc"].map((name) => {
    const stage = base.find((s) => s.name === name);
    if (stage === undefined) throw new Error(`no stage ${name}`);
    return stage;
  });

  test("names every package the shipped stages install", () => {
    const packages = shipped.flatMap(aptPackages);
    expect(packages.length).toBeGreaterThan(20);
    const missing = packages.filter((p) => !README.includes(`\`${p}\``));
    expect(missing).toEqual([]);
  });

  test("names every pinned tool at the version the Dockerfiles pin", () => {
    const pins: [string, string][] = [
      ["Python", pin(BASE, /^FROM ghcr\.io\/astral-sh\/uv:python(\d+\.\d+)-/m)],
      ["git", pin(BASE, /^ARG GIT_VERSION=(\S+)$/m)],
      ["ripgrep", pin(BASE, /^ARG RG_VERSION=(\S+)$/m)],
      ["jq", pin(BASE, /^FROM ghcr\.io\/jqlang\/jq:([^@\s]+)@/m)],
      ["yq", pin(BASE, /^FROM mikefarah\/yq:([^@\s]+)@/m)],
      ["Bun", pin(VARIANTS, /^FROM oven\/bun:([^@\s]+)@/m)],
      ["Go", pin(VARIANTS, /^FROM golang:(\d+\.\d+\.\d+)-/m)],
      ["Rust", pin(VARIANTS, /^FROM rust:(\d+\.\d+\.\d+)-/m)],
    ];
    for (const [name, version] of pins) {
      expect(row(README, name)?.[1], name).toBe(version);
    }
  });
});
