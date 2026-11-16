// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Memory tab: the project's note, which every chat and run
// reads, a chat's agent saves to, and anyone in the project edits.

import type { Params } from "../../app/params.ts";
import { keyOf, noteErrors, notes } from "../../data/memory.ts";
import { Note, NoteWaiting } from "../memory/Note.tsx";
import { Frame } from "./Frame.tsx";

export function Memory({ params }: { params: Params }) {
  const key = keyOf(params.id, null);
  const error = noteErrors.value.get(key) ?? null;
  return (
    <Frame
      id={params.id}
      tab="memory"
      waiting={<NoteWaiting />}
      busy={!notes.value.has(key) && error === null}
    >
      {() => (
        <Note
          memory={notes.value.get(key) ?? null}
          memoryKey={key}
          error={error}
          empty="No memory yet. Ask an agent in a chat to remember something."
        />
      )}
    </Frame>
  );
}
