// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's shell backend as its select draws it: the instance's
// default first, named with the instance's backend, then the two words.

import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import {
  SANDBOX_BACKENDS,
  type SandboxBackend,
} from "../../../shared/contracts/sandbox.ts";
import type { Option } from "../../ui/Select.model.ts";
import { BACKEND_OPTIONS } from "../admin/Sandbox.model.ts";

export const SHELL_TEXT = "Where the bash tool runs this project's commands.";
// a team member reads the value; an admin sets it
export const SHELL_ADMIN_HINT = "An admin sets it.";

// the select's value for a project that follows the instance
export const INSTANCE_DEFAULT = "default";

export const shellValue = (project: Pick<ProjectDetail, "backend">): string =>
  project.backend ?? INSTANCE_DEFAULT;

// the Sandbox page's words for each backend
const wordOf = (backend: SandboxBackend): string =>
  BACKEND_OPTIONS.find((option) => option.value === backend)?.label ?? backend;

export function shellOptions(instance: SandboxBackend): Option[] {
  return [
    {
      value: INSTANCE_DEFAULT,
      label: `Instance default (${wordOf(instance)})`,
    },
    ...SANDBOX_BACKENDS.map((backend) => ({
      value: backend,
      label: wordOf(backend),
    })),
  ];
}

// the backend a picked value sends, null following the instance
export function pickedBackend(value: string): SandboxBackend | null {
  if (value === INSTANCE_DEFAULT) return null;
  return SANDBOX_BACKENDS.find((backend) => backend === value) ?? null;
}
