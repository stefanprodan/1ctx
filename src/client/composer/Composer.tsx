// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The card the user writes in: the text that grows with it, the files
// added to it, the plus, the project chip on Home, the agent chip, the
// context readout, and Send, with Stop before it while the reply runs: a
// message sent then waits for the reply to end. Enter sends, Shift+Enter
// breaks a line. A lone /word opens the command menu and, in a chat, a
// lone @word the agents to summon; /location reads the position on
// Enter and sends it as a message. A waiting message's Edit puts its
// text here, and Send is Save until the edit is saved or let go. Two
// modes: a chat, where the message goes into it, and a project, where
// it starts one. Files come from the plus, a drop on the card or a
// paste, are staged as they are picked, and go with the send. The
// draft, text and staged files, survives a navigation; a refusal shows
// under the box until the next keystroke. In a project channel the
// message is a post: no agent chip, no switches, no chat commands, the
// @ menu lists every agent and the meter is the stream's.

import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo, useRef } from "preact/hooks";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { ProjectSummary } from "../../shared/contracts/project.ts";
import type {
  QueuedMessage,
  RoundUsage,
} from "../../shared/contracts/session.ts";
import { flip } from "../data/capabilities.ts";
import { me } from "../data/me.ts";
import { rememberAgent, startingAgent } from "../data/project-agents.ts";
import {
  askedOf,
  claimed,
  deleteUpload,
  forgetUpload,
  loadUploads,
  staged,
  stagedOf,
  stageUpload,
  takeStamp,
} from "../data/uploads.ts";
import { Icon } from "../lib/icons.tsx";
import { stepHighlight } from "../ui/Select.model.ts";
import { Add } from "./Add.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { AttachState } from "./Attach.state.ts";
import { Commands } from "./Commands.tsx";
import {
  type Command,
  commandBlock,
  commandFill,
  commandMatches,
  dispatchOf,
  enterFills,
  runCommand,
} from "./commands.ts";
import { readout, streamReadout } from "./context.ts";
import {
  draftKey,
  dropDraftUploads,
  readDraft,
  type Scope,
  writeDraftText,
  writeDraftUploads,
} from "./draft.ts";
import {
  EditLine,
  editOf,
  placeholderOf,
  SendButtons,
  saveEdit,
  useHandoff,
} from "./Edit.tsx";
import { Files } from "./Files.tsx";
import type { Editing } from "./handoff.ts";
import { browserLocate, type Locate, locate } from "./location.ts";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { Summons } from "./Summons.tsx";
import { summonFill, summonMatches } from "./summons.ts";
import { useSwitches } from "./switches.ts";
import "./composer.css";
import { says } from "../lib/format.ts";
import { touch } from "../lib/touch.ts";

const MAX_HEIGHT = 160;

const NONE_OFF: readonly string[] = [];

const BROWSER_READER = browserLocate();

export function Composer({
  scope,
  filesProjectId,
  agents,
  agentId,
  running,
  busy,
  usage,
  onSend,
  onStop,
  onCompact,
  onRename,
  onFork,
  queued,
  onEdit,
  project,
  off = NONE_OFF,
  placeholder: idle = "Message",
  reader = BROWSER_READER,
  channel,
}: {
  scope: Scope;
  // the project a file is staged in: the chat's, or the one a new chat
  // would start in
  filesProjectId: string;
  agents: AgentSummary[] | null;
  // the session's agent; null for a chat not started yet
  agentId: string | null;
  // a reply is streaming: Stop shows before Send
  running: boolean;
  // a send is on its way to the server
  busy: boolean;
  // the session's last counted round, for the context readout; none
  // for a chat not started yet
  usage?: RoundUsage | null;
  // what the chat has turned off, empty for one not started yet
  off?: readonly string[];
  // uploads are the staged ids the send claims
  onSend: (text: string, agentId: string, uploads: string[]) => Promise<void>;
  onStop: () => Promise<void>;
  // /compact runs a summary round on the chat; a chat not started yet
  // has nothing to fold, so the command is refused without a call
  onCompact?: () => Promise<void>;
  // /rename <title>; absent before the chat starts and for a viewer who
  // may not retitle it, whose menu then leaves it out
  onRename?: (title: string) => Promise<void>;
  // /fork <name>: the chat so far as a new chat under the name
  onFork?: (title: string) => Promise<void>;
  // the chat's waiting messages, and the save of an edit over one
  queued?: readonly QueuedMessage[];
  onEdit?: (row: Editing, text: string) => Promise<void>;
  // Home's pick of the project a new chat starts in; the draft stays
  // the scope's while the project changes under it
  project?: {
    projects: ProjectSummary[];
    projectId: string;
    onPick: (id: string) => void;
  };
  // the box at rest, with an agent to send to
  placeholder?: string;
  // /location's read of the position; null where the browser cannot
  // share one, which leaves the command out of the menu
  reader?: Locate | null;
  // a project channel by name ("#finops"), and its stream when counted
  channel?: { name: string; stream?: { tokens: number; budget: number } };
}) {
  const key = draftKey(me.value?.id ?? "", scope);
  const text = useSignal(readDraft(key).text);
  // files held over the card, by how deep the pointer is in its children
  const over = useSignal(0);
  const files = useMemo(
    () =>
      new AttachState(
        {
          stage: stageUpload,
          remove: deleteUpload,
          forget: (_projectId, attempt) => forgetUpload(attempt),
          reload: loadUploads,
          list: stagedOf,
          stamp: takeStamp,
          asked: askedOf,
          wait: (ms) => new Promise((done) => setTimeout(done, ms)),
          currentUser: () => me.value?.id ?? null,
          mint: () => crypto.randomUUID(),
          save: (uploads) => writeDraftUploads(key, uploads),
        },
        readDraft(key).uploads,
      ),
    [key],
  );
  useEffect(() => () => files.dispose(), [files]);
  // before the paint, so Send is never drawn on for a draft whose files
  // are not yet known to the state
  useLayoutEffect(() => files.show(filesProjectId), [files, filesProjectId]);
  const placed = files.projectId.value === filesProjectId;
  const held = staged.value.get(filesProjectId) ?? null;
  useEffect(() => files.reconcile(held), [files, held]);
  const failure = useSignal<string | null>(null);
  // /location waits on the browser before the send is out
  const locating = useSignal(false);
  // what the box is now, for a read that ends after a move or an unmount
  const live = useRef({ mounted: true, key, agent: null as string | null });
  useEffect(() => {
    live.current.mounted = true;
    return () => {
      live.current.mounted = false;
    };
  }, []);
  // the menu's highlight, and whether Escape shut it for this draft
  const highlight = useSignal(0);
  const shut = useSignal(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = agents ?? [];
  const fixed = agentId !== null || channel !== undefined;
  // a new chat starts on the user's last pick, kept across composers
  // and visits; one not in this project's list falls back to the default
  // a channel's post goes to no agent: its first word may summon one
  const agent = channel ? "" : fixed ? agentId : startingAgent(list);
  live.current.key = key;
  live.current.agent = agent;

  const grow = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight)}px`;
  };
  // the scope changed: the draft of the new one, and the cursor in the box
  useEffect(() => {
    text.value = readDraft(key).text;
    failure.value = null;
    if (!touch()) input.current?.focus();
  }, [key, text, failure]);
  useEffect(grow, [text.value]);

  // a message sent while the reply runs waits for it to end
  const ready = agent !== null && !busy && !locating.value;
  const readable =
    channel !== undefined ||
    (list.find((a) => a.id === agent)?.model.tools ?? false);
  const chat = "sessionId" in scope ? scope.sessionId : null;
  const edit = editOf(chat);
  const box = { key, text, failure };
  const saving = useHandoff(chat, box, input, queued);
  const switches = useSwitches({
    chat,
    off,
    agent,
    readable,
    projectId: filesProjectId,
  });
  const attach = (picked: File[]) => {
    failure.value = null;
    void files.add(picked, readable);
  };
  const started = onCompact !== undefined && onFork !== undefined;
  const block = (command: Command) =>
    commandBlock({ started, running, channel: channel !== undefined }, command);
  const quiet = shut.value || edit !== null;
  const matches = quiet
    ? []
    : commandMatches(
        text.value,
        !started || onRename !== undefined,
        reader !== null,
        channel !== undefined,
      );
  // the @ menu, in a chat only: a new chat cannot summon
  const summonable = quiet
    ? []
    : summonMatches(text.value, agents, agentId, channel !== undefined);
  // one menu at most is open, since a draft starts with / or @
  const count = matches.length + summonable.length;
  const fillAt = (index: number): string =>
    matches.length > 0
      ? commandFill(matches[index]!)
      : summonFill(summonable[index]!);
  // the highlight follows the list as it shrinks
  const chosen = Math.min(highlight.value, Math.max(0, count - 1));
  const pick = (fill: string) => {
    text.value = fill;
    writeDraftText(key, fill);
    input.current?.focus();
  };
  const submit = async () => {
    const content = text.value.trim();
    if (edit !== null)
      return saveEdit(edit, content, onEdit, { ...box, saving });
    // the signal itself, since a second Enter may beat the render
    if (content === "" || agent === null || !ready || locating.value) return;
    const to = dispatchOf(content);
    if (to.files && (!placed || files.busy)) return;
    failure.value = null;
    const sent = text.value;
    const uploads = to.files ? files.ids : [];
    try {
      if (to.kind === "command") {
        await runCommand(to.named, block(to.named.command), {
          onCompact,
          onRename,
          onFork,
        });
      } else if (to.kind === "location") {
        locating.value = true;
        const message = await locate(to.question, reader).finally(() => {
          locating.value = false;
        });
        // the box moved on while the browser asked: the stored draft
        // still holds the text, so nothing is lost
        const now = live.current;
        if (!now.mounted || now.key !== key || now.agent !== agent) return;
        await onSend(message, agent, uploads);
      } else await onSend(content, agent, uploads);
      // this composer may be gone by now (a new chat navigates away), so
      // the stored draft is what loses them
      if (to.files) {
        files.sent(uploads);
        dropDraftUploads(key, uploads);
        claimed(filesProjectId, uploads);
      }
      // what was typed while the send was on its way stays, here and in
      // the stored draft, which another composer may have written since
      if (text.value === sent) text.value = "";
      if (readDraft(key).text === sent) writeDraftText(key, "");
    } catch (err) {
      failure.value = says(err);
      // a file the send found gone moves to the log with the next list
      if (uploads.length > 0) void loadUploads(filesProjectId);
    }
  };
  const context = channel ? streamReadout(channel.stream) : readout(usage);
  // a chat not started yet has the page to itself, so the box shows
  // two lines at rest; in a chat the transcript needs the room
  const tall = !("sessionId" in scope);
  // a post needs no agent, so a channel without one still takes it
  const placeholder = placeholderOf(
    channel ? null : agents,
    running,
    channel ? `Message ${channel.name}` : idle,
  );
  const refusal = failure.value ?? files.refusal.value;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target has no role, and the plus does the same by keyboard
    <div
      class={`composer${tall ? " composer-tall" : ""}${over.value > 0 ? " composer-drop" : ""} card`}
      onDragEnter={(ev) => {
        if (!ev.dataTransfer?.types.includes("Files")) return;
        ev.preventDefault();
        over.value += 1;
      }}
      onDragOver={(ev) => {
        if (ev.dataTransfer?.types.includes("Files")) ev.preventDefault();
      }}
      onDragLeave={() => {
        over.value = Math.max(0, over.value - 1);
      }}
      onDrop={(ev) => {
        const dropped = [...(ev.dataTransfer?.files ?? [])];
        if (dropped.length === 0) return;
        ev.preventDefault();
        over.value = 0;
        attach(dropped);
      }}
    >
      {edit !== null && <EditLine open={edit} box={box} />}
      <textarea
        ref={input}
        class="composer-text"
        name="message"
        rows={tall ? 2 : 1}
        placeholder={placeholder}
        aria-label="Message"
        disabled={!channel && agents !== null && list.length === 0}
        value={text.value}
        onInput={(ev) => {
          text.value = ev.currentTarget.value;
          failure.value = null;
          shut.value = false;
          highlight.value = 0;
          files.refusal.value = null;
          writeDraftText(key, ev.currentTarget.value);
        }}
        onPaste={(ev) => {
          // pasted files are added, pasted text stays text
          const pasted = [...(ev.clipboardData?.files ?? [])];
          if (pasted.length === 0) return;
          ev.preventDefault();
          attach(pasted);
        }}
        onKeyDown={(ev) => {
          if (ev.isComposing) return;
          if (count > 0) {
            const move =
              ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : 0;
            if (move !== 0) {
              ev.preventDefault();
              highlight.value = stepHighlight(chosen, count, move);
              return;
            }
            if (ev.key === "Escape") {
              ev.preventDefault();
              shut.value = true;
              return;
            }
            const fill = fillAt(chosen);
            const fills =
              matches.length > 0
                ? enterFills(text.value, matches[chosen]!)
                : text.value !== fill;
            if (ev.key === "Tab" || (ev.key === "Enter" && fills)) {
              ev.preventDefault();
              text.value = fill;
              writeDraftText(key, fill);
              return;
            }
          }
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void submit();
          }
        }}
      />
      {matches.length > 0 && (
        <Commands
          matches={matches}
          chosen={chosen}
          block={block}
          onPick={(command) => pick(commandFill(command))}
          onHover={(index) => {
            highlight.value = index;
          }}
        />
      )}
      {summonable.length > 0 && (
        <Summons
          matches={summonable}
          chosen={chosen}
          onPick={(agent) => pick(summonFill(agent))}
          onHover={(index) => {
            highlight.value = index;
          }}
        />
      )}
      <Files
        items={files.shown}
        onRemove={(item) => files.remove(item)}
        onClear={() => files.clear()}
      />
      {refusal && <p class="composer-failure error">{refusal}</p>}
      {over.value > 0 && (
        <div class="composer-drop-words">
          <Icon name="clip" size={16} class="composer-drop-icon" />
          <span>Drop files to add them</span>
        </div>
      )}
      <div class="composer-row">
        <Add
          readable={readable}
          filesOnly={channel !== undefined}
          onFiles={attach}
          {...switches}
          onFlip={(key) => flip(chat, off, key)}
        />
        {project && (
          <ProjectPicker
            projects={project.projects}
            projectId={project.projectId}
            onPick={project.onPick}
          />
        )}
        {!channel && (
          <AgentPicker
            agents={agents}
            agentId={agent}
            onPick={fixed ? undefined : (id) => void rememberAgent(id)}
          />
        )}
        {context && (
          <span class="composer-ctx" title={context.title}>
            <span>{context.text}</span>
            <span class="meter composer-ctx-meter">
              <span
                class="meter-fill"
                style={{ width: `${context.percent}%` }}
              />
            </span>
          </span>
        )}
        <SendButtons
          save={edit !== null}
          onStop={running ? onStop : undefined}
          failure={failure}
          off={
            text.value.trim() === "" ||
            (edit !== null ? saving.value : !ready || !placed || files.busy)
          }
          onSend={() => void submit()}
        />
      </div>
    </div>
  );
}
