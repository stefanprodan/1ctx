// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell backends' words, as the Sandbox page and a project's shell
// select both draw them.

import type { SandboxBackend } from "../../shared/contracts/sandbox.ts";

export const BACKEND_OPTIONS: { value: SandboxBackend; label: string }[] = [
  { value: "builtin", label: "Built-in" },
  { value: "openshell", label: "OpenShell" },
];

export const backendWord = (backend: SandboxBackend): string =>
  BACKEND_OPTIONS.find((option) => option.value === backend)?.label ?? backend;
