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
const ENDS = new Set([".", ",", ":", ";", "!", "?"]);

// the word after a leading @, as typed; null when the message does not
// open with one
export function summonWord(text: string): string | null {
  return FIRST.exec(text)?.[1] ?? null;
}

// the name the word calls: lowercase, since names are, without the
// punctuation that ends it in "@glm, check" or "@glm: check"; null when
// the message does not open with one
export function summonName(text: string): string | null {
  const word = summonWord(text);
  if (word === null) return null;
  // walked from the end: a regex anchored there rescans a long run of
  // punctuation from each of its marks
  let end = word.length;
  while (end > 0 && ENDS.has(word[end - 1]!)) end--;
  return end === 0 ? null : word.slice(0, end).toLowerCase();
}

// the chat's own agent is an ordinary turn
export function readSummon(
  text: string,
  chatAgent: string,
  isAgent: (name: string) => boolean,
): Summon {
  const word = summonWord(text);
  const name = summonName(text);
  if (word === null || name === null) return { kind: "none" };
  if (name === chatAgent) return { kind: "none" };
  return isAgent(name) ? { kind: "summon", name } : { kind: "unknown", word };
}

export const noAgentNamed = (word: string): string => `no agent named ${word}`;
