// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The refusal under the field it names, in place of the field's hint.

import type { Save } from "../lib/save.ts";

export function FieldError({ save, field }: { save: Save; field: string }) {
  const error = save.fieldError(field);
  if (error === null) return null;
  return (
    <span class="field-error" role="alert">
      {error}
    </span>
  );
}
