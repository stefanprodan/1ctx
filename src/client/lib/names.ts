// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { shapeName } from "../../shared/names.ts";

export function shapedInput(event: Event): string {
  const box = event.currentTarget as HTMLInputElement;
  box.value = shapeName(box.value);
  return box.value;
}

// the field shapes the name as it is typed and the server holds the
// rule, so the one slip worth catching here is an empty field
export function nameProblem(value: string): string | null {
  return value.trim() === "" ? "Enter a name" : null;
}

// another row holds the name, or it is reserved
export function nameTaken(
  rows: readonly { id: string; name: string }[] | null,
  name: string,
  exceptId = "",
  reserved: readonly string[] = [],
): boolean {
  const n = name.trim();
  return (
    reserved.includes(n) ||
    (rows?.some((r) => r.name === n && r.id !== exceptId) ?? false)
  );
}
