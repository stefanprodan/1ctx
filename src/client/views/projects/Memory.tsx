// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Memory tab: the project's note, which every chat and run
// reads and anyone in the project edits.

import type { Params } from "../../app/params.ts";
import { keyOf, noteErrors, notes } from "../../data/memory.ts";
import { Note } from "../memory/Note.tsx";
import { Frame } from "./Frame.tsx";

export function Memory({ params }: { params: Params }) {
  const key = keyOf(params.id, null);
  return (
    <Frame id={params.id} tab="memory">
      {() => (
        <Note
          memory={notes.value.get(key) ?? null}
          memoryKey={key}
          error={noteErrors.value.get(key) ?? null}
          empty="No memory yet. Every chat and run in this project reads it."
        />
      )}
    </Frame>
  );
}
