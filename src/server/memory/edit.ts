// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat's edit, pure: it applies only over the text the chat has seen.

import type { MemoryEntry } from "../../shared/contracts/memory.ts";
import {
  applyEdit,
  findTopic,
  MEMORY_ENTRY_CHARS,
  type MemoryEdit,
  memorySize,
  resultThere,
  sameTopic,
} from "../../shared/memory.ts";

export type ChatMemoryEdit = Exclude<MemoryEdit, { action: "none" }>;

export type ChatEditOutcome =
  | {
      ok: true;
      entries: MemoryEntry[];
      seen: MemoryEntry[];
      changed: boolean;
    }
  | {
      ok: false;
      reason: string;
      seen: MemoryEntry[];
      // another chat wrote or removed the topic since this chat saw it
      conflict: "wrote" | "removed" | null;
    };

function seenWith(
  seen: readonly MemoryEntry[],
  topic: string,
  entry: MemoryEntry | undefined,
): MemoryEntry[] {
  const rest = seen.filter((held) => !sameTopic(held.topic, topic));
  return entry === undefined ? rest : [...rest, { ...entry }];
}

export function chatEdit(
  note: readonly MemoryEntry[],
  seen: readonly MemoryEntry[],
  edit: ChatMemoryEdit,
): ChatEditOutcome {
  const current = findTopic(note, edit.topic);
  const saw = findTopic(seen, edit.topic);
  const all = note.map((entry) => ({ ...entry }));
  // a remove of a topic nobody wrote falls through to the unknown topic
  const there =
    resultThere(current, edit) && (edit.action === "set" || saw !== undefined);
  if (there) {
    return {
      ok: true,
      entries: all,
      seen: seenWith(seen, edit.topic, current),
      changed: false,
    };
  }
  const matches =
    saw === undefined
      ? current === undefined
      : current !== undefined && current.text === saw.text;
  if (!matches) {
    const reason =
      current === undefined
        ? `Another chat removed the topic ${saw!.topic} since this chat last saw it. Set it again only if it is still needed.`
        : `Another chat wrote the topic ${current.topic} since this chat last saw it. Its text is in the note below. ${edit.action === "set" ? "Merge your text into it and set it again." : "Remove it again only if it is still stale."}`;
    return {
      ok: false,
      reason,
      seen: all,
      conflict: current === undefined ? "removed" : "wrote",
    };
  }
  const result = applyEdit(note, edit);
  if (!result.ok) {
    // The shared words are also the page's, so the advice that names
    // the tool's calls is added here.
    const advice =
      result.kind === "match" && note.length > 0
        ? " Use one of the topics in the note."
        : result.kind === "budget"
          ? " Shorten, merge or remove entries, or leave out what later chats do not need."
          : result.kind === "long"
            ? " Split it into several topics, one set call each, or cut it."
            : "";
    const reason = result.kind === "budget" ? result.bare : result.reason;
    return {
      ok: false,
      reason: `${reason}${advice}`,
      seen: all,
      conflict: null,
    };
  }
  return {
    ok: true,
    entries: result.entries,
    seen: seenWith(seen, edit.topic, findTopic(result.entries, edit.topic)),
    changed: true,
  };
}

export function savedWords(entries: readonly MemoryEntry[]): string {
  return `Saved to the project's memory. ${memorySize(entries)} characters.`;
}

// every refusal hands back the note as it stands, so the next call names
// an entry that is really there
export function noteWords(
  reason: string,
  entries: readonly MemoryEntry[],
): string {
  const size = `${memorySize(entries)} characters.`;
  if (entries.length === 0) {
    return `${reason}\n${size}`;
  }
  const lines = entries.map((entry, index) => {
    return `${index + 1}. ${entry.topic} [${entry.text.length}/${MEMORY_ENTRY_CHARS}]\n${entry.text}`;
  });
  return `${reason}\n${lines.join("\n\n")}\n${size}`;
}
