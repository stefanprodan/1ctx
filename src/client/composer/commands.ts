// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The slash commands and the menu's logic without a DOM: which
// commands a draft is naming, the one it names exactly, where the
// keyboard moves the highlight, and why a command cannot run right
// now. A draft is a command only while it is one word starting with
// a slash; a sentence that happens to start with one is a message.

export type CommandName = "compact";

export type Command = {
  name: CommandName;
  text: string;
};

export const COMMANDS: readonly Command[] = [
  {
    name: "compact",
    text: "Free up context by summarizing the conversation",
  },
];

// what the menu filters on: the word after the slash, null when the
// draft is not a lone slash word
export function commandQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  if (/\s/.test(draft)) return null;
  return draft.slice(1);
}

export function commandMatches(draft: string): Command[] {
  const query = commandQuery(draft);
  if (query === null) return [];
  return COMMANDS.filter((command) => command.name.startsWith(query));
}

// the command a sent text names exactly, else null
export function commandOf(text: string): Command | null {
  const query = commandQuery(text.trim());
  if (query === null) return null;
  return COMMANDS.find((command) => command.name === query) ?? null;
}

// the highlight moves and wraps; an empty list has no highlight
export function moveHighlight(
  index: number,
  count: number,
  step: 1 | -1,
): number {
  if (count === 0) return 0;
  return (index + step + count) % count;
}

export type CommandState = {
  // the chat exists: a project page composer has none yet
  started: boolean;
  running: boolean;
};

// why a command is greyed in the menu and refused on Enter; every
// command today needs a started chat with nothing running
export function commandBlock(state: CommandState): string | null {
  if (!state.started) return "the chat has not started";
  if (state.running) return "a reply is running";
  return null;
}
