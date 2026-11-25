// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What each sandbox image variant holds, as bash's description names
// it. The versions are the two Dockerfiles' under deploy/sandbox, and
// a test fails when they disagree.

import type { SandboxVariant } from "../../../shared/contracts/sandbox.ts";

export type ShellTools = {
  // after "Linux sandbox: ", up to the sentence's end
  tools: string;
  // after "Install with ", up to the sentence's end
  install: string;
};

export const SHELL_VERSIONS = {
  python: "3.15",
  bun: "1.4",
  go: "1.27",
  rust: "1.100",
} as const;

const BASE = `Python ${SHELL_VERSIONS.python} with uv`;
const DATA = "git, make, jq, yq, rg and pdftotext";
const UV = "uv run --with pkg, a venv under $HOME";

export const SHELL_TOOLS: Readonly<Record<SandboxVariant, ShellTools>> = {
  python: {
    tools: `${BASE}, ${DATA}; no node`,
    install: "uv run --with pkg or a venv under $HOME",
  },
  bun: {
    tools: `${BASE}, Bun ${SHELL_VERSIONS.bun} (node and npx run on Bun), ${DATA}`,
    install: `${UV}, or bun add in a project under $HOME`,
  },
  go: {
    tools: `${BASE}, Go ${SHELL_VERSIONS.go} with cgo and gcc, ${DATA}; no node, no extra system libraries`,
    install: `${UV}, or go install; modules come through the proxy`,
  },
  rust: {
    tools: `${BASE}, Rust ${SHELL_VERSIONS.rust} with cargo and gcc, ${DATA}; no node`,
    install: `${UV}, cargo add or cargo install`,
  },
};

// a custom image: 1ctx needs Python and uv, the rest is the admin's
export const CUSTOM_TOOLS: ShellTools = {
  tools: "Python 3 with uv; check what else is installed with command -v",
  install: "uv run --with pkg or a venv under $HOME",
};

export const shellTools = (variant: SandboxVariant | null): ShellTools =>
  variant === null ? CUSTOM_TOOLS : SHELL_TOOLS[variant];
