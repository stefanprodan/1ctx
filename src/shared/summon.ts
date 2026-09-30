// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A summon is a chat message whose first word is @name: that agent
// answers the one turn. The server and the composer read it the same
// way, so a typo is refused in the composer with the server's words.

export type Summon =
  | { kind: "none" }
  | { kind: "summon"; name: string }
  | { kind: "unknown"; word: string };

const FIRST = /^\s*@(\S+)/;

// the word after a leading @, as typed; null when the message does not
// open with one
export function summonWord(text: string): string | null {
  return FIRST.exec(text)?.[1] ?? null;
}

// names are lowercase, so the word matches regardless of case; the
// chat's own agent is an ordinary turn
export function readSummon(
  text: string,
  chatAgent: string,
  isAgent: (name: string) => boolean,
): Summon {
  const word = summonWord(text);
  if (word === null) return { kind: "none" };
  const name = word.toLowerCase();
  if (name === chatAgent) return { kind: "none" };
  return isAgent(name) ? { kind: "summon", name } : { kind: "unknown", word };
}

export const noAgentNamed = (word: string): string => `no agent named ${word}`;
