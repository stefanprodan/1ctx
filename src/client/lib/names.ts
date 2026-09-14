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
