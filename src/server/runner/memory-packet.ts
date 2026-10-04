// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the memory phase is told, in place of the run's history: the
// run's record (run-record.ts), the guidance and the note to edit, under
// the phase's own system prompt. Pure, over the rows and a token count.

import type { MemoryEntry } from "../../shared/contracts/memory.ts";
import type { Message } from "../../shared/contracts/session.ts";
import { MEMORY_ENTRY_CHARS, memorySize } from "../../shared/memory.ts";
import type { SendCause } from "../../shared/words.ts";
import type { ChatMessageIn } from "../providers/index.ts";
import { MEMORY_WRITE_RULES } from "../tools/index.ts";
import {
  fitRecord,
  type RecordContext,
  type RecordParts,
  recordParts,
  recordSections,
} from "./run-record.ts";

export type MemoryPacket = {
  // the automation whose note the phase edits, named in its system prompt
  automation: string;
  sendId: string;
  memoryRound: number;
  cause: SendCause;
  error: string | null;
  rows: readonly Message[];
  guidance: string;
  entries: readonly MemoryEntry[];
};

type MemoryContext = RecordContext & { phase: ChatMessageIn[] };

export function memorySystem(automation: string): string {
  return `You keep the memory of the ${automation} automation. Its run is over. You do not do its task, call any tool other than memory_edit, or write an answer. You read the record of the run and edit the note with memory_edit calls, and nothing else.`;
}

function currentEntries(entries: readonly MemoryEntry[]): string {
  const version = "This is the version to edit.";
  if (entries.length === 0) {
    return `This automation's own memory is empty. Use set to write its first entry.\n${memorySize(entries)} characters.\n${version}`;
  }
  const lines = entries.map(
    (entry, index) =>
      `${index + 1}. ${entry.topic} [${entry.text.length}/${MEMORY_ENTRY_CHARS}]\n${entry.text}`,
  );
  return `This automation's own memory holds ${entries.length} ${
    entries.length === 1 ? "entry" : "entries"
  }, the version to edit:\n${lines.join("\n\n")}\n${memorySize(entries)} characters.\n${version}`;
}

function phaseInstruction(packet: MemoryPacket, parts: RecordParts): string {
  return [
    ...recordSections(parts),
    ...(packet.guidance === ""
      ? []
      : [`What to remember:\n${packet.guidance}`]),
    currentEntries(packet.entries),
    "A topic names what an entry is about, never one fact. set creates or replaces the entry of that topic; put facts under an existing topic when they belong there. remove deletes a topic.",
    MEMORY_WRITE_RULES,
    ...(packet.guidance === ""
      ? []
      : [
          "For facts worth keeping, write each topic named in What to remember as its own entry with its own set call.",
        ]),
    "Before sending, check each text is under 500 characters and the note stays under 2,200; remove or shorten topics in the same round.",
    "Reply with memory_edit calls only, no text. Calls in one round run in order, so send every edit in one round; the phase ends after a round whose edits all succeed.",
  ].join("\n\n");
}

export function memoryMessages(
  packet: MemoryPacket,
  context: MemoryContext,
  count: (text: string) => number,
): ChatMessageIn[] | null {
  const parts = recordParts({
    sendId: packet.sendId,
    before: packet.memoryRound,
    cause: packet.cause,
    error: packet.error,
    rows: packet.rows,
  });
  const build = (current: RecordParts): ChatMessageIn[] => [
    { role: "system", content: memorySystem(packet.automation) },
    { role: "user", content: phaseInstruction(packet, current) },
    ...context.phase,
  ];
  return fitRecord(parts, build, context, count);
}
