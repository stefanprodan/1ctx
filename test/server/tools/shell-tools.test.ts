// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// bash's description under the sandbox shell names the tools of the
// image variant its sandbox runs, at the versions the Dockerfile pins.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  makeBashTool,
  offeredShell,
} from "../../../src/server/tools/builtin/bash.ts";
import {
  CUSTOM_TOOLS,
  SHELL_TOOLS,
  SHELL_VERSIONS,
} from "../../../src/server/tools/builtin/shell-tools.ts";
import {
  SANDBOX_VARIANTS,
  type SandboxVariant,
} from "../../../src/shared/contracts/sandbox.ts";

const hosts = { mode: "hosts" as const, hosts: ["pypi.org"] };
const web = { mode: "all" as const, domains: [] };
const words = (variant: SandboxVariant | null) =>
  makeBashTool({ web, sandbox: hosts, variant }).description;

const DOCKERFILE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "deploy",
  "sandbox",
  "Dockerfile",
);

describe("bash's tools by image variant", () => {
  test("each variant names its own tools and install hint", () => {
    expect(words("python")).toContain(
      "Linux sandbox: Python 3.15 with uv, git, make, jq, yq, rg and pdftotext; no node. /knowledge",
    );
    expect(words("python")).toContain(
      "Install with uv run --with pkg or a venv under $HOME. ",
    );
    expect(words("bun")).toContain(
      "Linux sandbox: Python 3.15 with uv, Bun 1.4 (node and npx run on Bun), git, make, jq, yq, rg and pdftotext. /knowledge",
    );
    expect(words("bun")).toContain(
      "Install with uv run --with pkg, a venv under $HOME, or bun add in a project under $HOME. ",
    );
    expect(words("go")).toContain(
      "Linux sandbox: Python 3.15 with uv, Go 1.27 with cgo and gcc, git, make, jq, yq, rg and pdftotext; no node, no extra system libraries. /knowledge",
    );
    expect(words("go")).toContain(
      "Install with uv run --with pkg, a venv under $HOME, or go install; modules come through the proxy. ",
    );
    expect(words("rust")).toContain(
      "Linux sandbox: Python 3.15 with uv, Rust 1.100 with cargo and gcc, git, make, jq, yq, rg and pdftotext; no node. /knowledge",
    );
    expect(words("rust")).toContain(
      "Install with uv run --with pkg, a venv under $HOME, cargo add or cargo install. ",
    );
    // only bun's names Bun, only go's Go, only rust's cargo
    for (const variant of SANDBOX_VARIANTS) {
      const text = words(variant);
      expect(text.includes("Bun"), variant).toBe(variant === "bun");
      expect(text.includes("Go 1."), variant).toBe(variant === "go");
      expect(text.includes("cargo"), variant).toBe(variant === "rust");
    }
  });

  test("a custom image says Python and uv, and to look for the rest", () => {
    const text = words(null);
    expect(text).toContain(
      "Linux sandbox: Python 3 with uv; check what else is installed with command -v. /knowledge",
    );
    expect(text).toContain(`Install with ${CUSTOM_TOOLS.install}. `);
    expect(text).not.toContain("3.15");
  });

  test("the offer reads the variant with the network, for the send's project", () => {
    const asked: (string | null | undefined)[] = [];
    const bash = {
      run: async () => ({ content: "", error: false }),
      sandbox: () => hosts,
      sandboxVariant: (projectId?: string | null) => {
        asked.push(projectId);
        return "go" as const;
      },
    };
    expect(offeredShell(bash, { sandbox: true }, "p1")).toMatchObject({
      sandbox: hosts,
      variant: "go",
    });
    expect(asked).toEqual(["p1"]);
    // the built-in shell asks nothing of the image
    expect(offeredShell(bash, { sandbox: false }, "p1")).not.toHaveProperty(
      "variant",
    );
    expect(asked).toEqual(["p1"]);
    expect(
      makeBashTool({ bash, web, ...offeredShell(bash, { sandbox: true }) })
        .description,
    ).toContain("Go 1.27");
  });

  test("the versions are the Dockerfile's", async () => {
    const text = await Bun.file(DOCKERFILE).text();
    const arg = (name: string) => {
      const found = new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(text);
      if (found === null) throw new Error(`no ARG ${name}`);
      return found[1]!;
    };
    const python = /^FROM ghcr\.io\/astral-sh\/uv:python(\d+\.\d+)-/m.exec(
      text,
    );
    expect(python?.[1]).toBe(SHELL_VERSIONS.python);
    const minor = (version: string) => version.split(".").slice(0, 2).join(".");
    expect(minor(arg("BUN_VERSION"))).toBe(SHELL_VERSIONS.bun);
    expect(minor(arg("GO_VERSION"))).toBe(SHELL_VERSIONS.go);
    expect(minor(arg("RUST_VERSION"))).toBe(SHELL_VERSIONS.rust);
    // every variant is a target, and the table has one row each
    for (const variant of SANDBOX_VARIANTS) {
      expect(text).toMatch(new RegExp(`^FROM \\S+ AS ${variant}$`, "m"));
    }
    expect(Object.keys(SHELL_TOOLS).sort()).toEqual(
      [...SANDBOX_VARIANTS].sort(),
    );
  });
});
