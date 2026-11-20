// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell backends' and image variants' words, as the Sandbox page
// and a project's shell select both draw them.

import type {
  SandboxBackend,
  SandboxVariant,
} from "../../shared/contracts/sandbox.ts";

export const BACKEND_OPTIONS: { value: SandboxBackend; label: string }[] = [
  { value: "builtin", label: "Built-in" },
  { value: "openshell", label: "OpenShell" },
];

export const backendWord = (backend: SandboxBackend): string =>
  BACKEND_OPTIONS.find((option) => option.value === backend)?.label ?? backend;

export const VARIANT_OPTIONS: { value: SandboxVariant; label: string }[] = [
  { value: "python", label: "Python" },
  { value: "bun", label: "Bun" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
];

export const variantWord = (variant: SandboxVariant): string =>
  VARIANT_OPTIONS.find((option) => option.value === variant)?.label ?? variant;

// what each variant holds past the others, for its hint
const VARIANT_LINES: Record<SandboxVariant, string> = {
  python: "Python and uv, git, make, jq, yq and rg.",
  bun: "The Python image and Bun, which runs node and npx.",
  go: "The Python image, Go with cgo and gcc.",
  rust: "The Python image, Rust with cargo and gcc.",
};

export const variantLine = (variant: SandboxVariant): string =>
  VARIANT_LINES[variant];
