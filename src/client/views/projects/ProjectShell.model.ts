// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's shell backend and image variant as their selects draw
// them: the instance's default first, named with the instance's value,
// then the words.

import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import {
  SANDBOX_BACKENDS,
  SANDBOX_VARIANTS,
  type SandboxBackend,
  type SandboxVariant,
} from "../../../shared/contracts/sandbox.ts";
import {
  backendWord,
  VARIANT_OPTIONS,
  variantLine,
  variantWord,
} from "../../lib/backends.ts";
import type { Option } from "../../ui/Select.model.ts";

export const SHELL_TEXT = "Where the bash tool runs this project's commands.";
// anyone but an admin reads the value
export const SHELL_ADMIN_HINT = "An admin sets it.";

// the select's value for a project that follows the instance
export const INSTANCE_DEFAULT = "default";

export const shellValue = (project: Pick<ProjectDetail, "backend">): string =>
  project.backend ?? INSTANCE_DEFAULT;

export function shellOptions(instance: SandboxBackend): Option[] {
  return [
    {
      value: INSTANCE_DEFAULT,
      label: `Instance default (${backendWord(instance)})`,
    },
    ...SANDBOX_BACKENDS.map((backend) => ({
      value: backend,
      label: backendWord(backend),
    })),
  ];
}

// the backend a picked value sends, null following the instance
export function pickedBackend(value: string): SandboxBackend | null {
  if (value === INSTANCE_DEFAULT) return null;
  return SANDBOX_BACKENDS.find((backend) => backend === value) ?? null;
}

export const VARIANT_TEXT = "The tools the sandbox shell's image holds.";
// a custom image on the instance replaces every variant
export const CUSTOM_IMAGE_HINT = "The instance's custom image replaces it.";

export const variantValue = (project: Pick<ProjectDetail, "variant">): string =>
  project.variant ?? INSTANCE_DEFAULT;

// null: the instance runs a custom image
export function variantOptions(instance: SandboxVariant | null): Option[] {
  const named = instance === null ? "custom image" : variantWord(instance);
  return [
    { value: INSTANCE_DEFAULT, label: `Instance default (${named})` },
    ...VARIANT_OPTIONS,
  ];
}

// the variant a picked value sends, null following the instance
export function pickedVariant(value: string): SandboxVariant | null {
  if (value === INSTANCE_DEFAULT) return null;
  return SANDBOX_VARIANTS.find((variant) => variant === value) ?? null;
}

// what the project's sandbox holds, the hint under its select
export function variantHint(
  project: Pick<ProjectDetail, "variant" | "instanceVariant">,
): string {
  if (project.instanceVariant === null) return CUSTOM_IMAGE_HINT;
  return variantLine(project.variant ?? project.instanceVariant);
}
