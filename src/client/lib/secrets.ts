// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Option } from "../ui/Select.model.ts";

export const NO_KEY = "";

export function keyOptions(keys: string[], current: string | null): Option[] {
  const options: Option[] = [{ value: NO_KEY, label: "No key" }];
  for (const key of keys) options.push({ value: key, label: key });
  // a name whose file is gone stays on the list, so a form says why
  // the provider or server it names stopped answering
  if (current !== null && !keys.includes(current)) {
    options.push({ value: current, label: current, detail: "missing" });
  }
  return options;
}
