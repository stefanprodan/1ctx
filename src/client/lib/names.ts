// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A name field's input: the box shows the shaped name at once, so what
// is typed is what is saved, and the caller gets the same value.

import { shapeName } from "../../shared/words.ts";

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
