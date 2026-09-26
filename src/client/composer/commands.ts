// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The slash commands and the menu's logic without a DOM: which
// commands a draft is naming, the one it names exactly with what
// follows it, where the keyboard moves the highlight, and why a
// command cannot run right now. The menu is open only while the draft
// is one word starting with a slash; a command that takes an argument
// runs from the first word, and a sentence that happens to start with
// a bare command's word is a message.

export type CommandName = "compact" | "rename" | "fork";

export type Command = {
  name: CommandName;
  text: string;
  // the argument's name in the menu; null for a bare command
  arg: string | null;
};

// by name, the order the menu shows
export const COMMANDS: readonly Command[] = [
  {
    name: "compact",
    text: "Free up context by summarizing the conversation",
    arg: null,
  },
  {
    name: "fork",
    text: "Copy the chat so far into a new one with this name",
    arg: "name",
  },
  {
    name: "rename",
    text: "Give the chat a title",
    arg: "title",
  },
];

// what the box fills on Tab: the word, and a space after one that
// takes an argument
export function commandFill(command: Command): string {
  return command.arg === null ? `/${command.name}` : `/${command.name} `;
}

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

// the command a sent text names exactly and what follows it, else null:
// a bare command followed by anything is a message
export function commandOf(
  text: string,
): { command: Command; arg: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return null;
  const command = COMMANDS.find((c) => c.name === match[1]);
  if (command === undefined) return null;
  const arg = match[2]?.trim() ?? "";
  if (command.arg === null && arg !== "") return null;
  return { command, arg };
}

export type CommandHandlers = {
  onCompact?: () => Promise<void>;
  onRename?: (title: string) => Promise<void>;
  // /fork <name>: the chat so far, on the same agent, under the name
  onFork?: (title: string) => Promise<void>;
};

// what Enter does with a command: refused with the block's reason, or
// with what the command lacks; else the handler runs. A handler absent
// is a composer for a chat not started yet
export async function runCommand(
  named: { command: Command; arg: string },
  block: string | null,
  handlers: CommandHandlers,
): Promise<void> {
  const { onCompact, onRename, onFork } = handlers;
  if (
    block !== null ||
    onCompact === undefined ||
    onRename === undefined ||
    onFork === undefined
  ) {
    throw new Error(`/${named.command.name}: ${block ?? "not now"}`);
  }
  if (named.command.name === "rename") {
    if (named.arg === "") throw new Error("/rename needs a title");
    await onRename(named.arg);
  } else if (named.command.name === "fork") {
    if (named.arg === "") throw new Error("/fork needs a name");
    await onFork(named.arg);
  } else await onCompact();
}

export type CommandState = {
  // the chat exists: a project page composer has none yet
  started: boolean;
  running: boolean;
};

// why a command is greyed in the menu and refused on Enter: every
// command needs a started chat, and all but rename wait for a running
// reply, since a title is never the send's to write
export function commandBlock(
  state: CommandState,
  command: Command,
): string | null {
  if (!state.started) return "the chat has not started";
  if (state.running && command.name !== "rename") return "a reply is running";
  return null;
}
