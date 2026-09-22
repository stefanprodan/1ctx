// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The card the user writes in: the text that grows with it, the files
// added to it, the plus, the project chip on Home, the agent chip, the
// context readout, and Send, which is Stop while the reply runs. Enter
// sends, Shift+Enter breaks a line. Two modes: a chat, where the message
// goes into it, and a project, where it starts one. Files come from the
// plus, a drop on the card or a paste, are staged as they are picked,
// and go with the send. The draft, text and staged files, survives a
// navigation; a refusal shows under the box until the next keystroke.

import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo, useRef } from "preact/hooks";
import { MCP, SKILL, VISUALIZE, WEB } from "../../shared/capabilities.ts";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { ProjectSummary } from "../../shared/contracts/project.ts";
import type { RoundUsage } from "../../shared/contracts/session.ts";
import {
  dropFlips,
  dropKind,
  flip,
  isOff,
  servers,
  skills,
  switchable,
} from "../data/capabilities.ts";
import { me } from "../data/me.ts";
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
import {
  agentMoved,
  serversItem,
  skillsItem,
  visualsItem,
  webItem,
} from "./Add.model.ts";
import { Add } from "./Add.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { AttachState } from "./Attach.state.ts";
import { Commands } from "./Commands.tsx";
import {
  type Command,
  commandBlock,
  commandFill,
  commandMatches,
  commandOf,
  moveHighlight,
  runCommand,
} from "./commands.ts";
import { readout } from "./context.ts";
import {
  draftKey,
  dropDraftUploads,
  readDraft,
  writeDraftText,
  writeDraftUploads,
} from "./draft.ts";
import { Files } from "./Files.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import "./composer.css";
import { says } from "../lib/format.ts";
import { touch } from "../lib/touch.ts";

export const MAX_HEIGHT = 160;

export type Scope = { sessionId: string } | { projectId: string };

const NONE_OFF: readonly string[] = [];

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
  project,
  off = NONE_OFF,
  placeholder: idle = "Send a message",
}: {
  scope: Scope;
  // the project a file is staged in: the chat's, or the one a new chat
  // would start in
  filesProjectId: string;
  agents: AgentSummary[] | null;
  // the session's agent; null for a chat not started yet
  agentId: string | null;
  // a reply is streaming: Send is Stop
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
  // /rename <title>; a chat not started yet has no row to name
  onRename?: (title: string) => Promise<void>;
  // /fork <name>: the chat so far as a new chat under the name
  onFork?: (title: string) => Promise<void>;
  // Home's pick of the project a new chat starts in; the draft stays
  // the scope's while the project changes under it
  project?: {
    projects: ProjectSummary[];
    projectId: string;
    onPick: (id: string) => void;
  };
  // the box at rest, with an agent to send to
  placeholder?: string;
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
  const picked = useSignal<string | null>(null);
  const failure = useSignal<string | null>(null);
  // the menu's highlight, and whether Escape shut it for this draft
  const highlight = useSignal(0);
  const shut = useSignal(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = agents ?? [];
  const fixed = agentId !== null;
  // a pick not in the list, the agents of another project, falls back
  // to the first
  const agent = fixed
    ? agentId
    : list.some((a) => a.id === picked.value)
      ? picked.value
      : (list[0]?.id ?? null);

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

  const ready = agent !== null && !busy && !running;
  const readable = list.find((a) => a.id === agent)?.model.tools ?? false;
  const chat = "sessionId" in scope ? scope.sessionId : null;
  // a flip never sent does not wait for the next visit to the chat
  useEffect(() => () => dropFlips(chat), [chat]);
  const web = webItem({
    tools: readable,
    switchable: switchable.value,
    off: isOff(chat, off, WEB),
  });
  const visuals = visualsItem({
    tools: readable,
    switchable: switchable.value,
    off: isOff(chat, off, VISUALIZE),
  });
  // another agent's servers and skills are other keys, so its flips go
  // with it
  const lastAgent = useRef<string | null>(null);
  useEffect(() => {
    if (agentMoved(lastAgent.current, agent)) {
      dropKind(chat, MCP);
      dropKind(chat, SKILL);
    }
    if (agent !== null) lastAgent.current = agent;
  }, [chat, agent]);
  const mcp = serversItem({
    tools: readable,
    servers: (agent === null ? undefined : servers.value[agent]) ?? [],
    isOff: (key) => isOff(chat, off, key),
  });
  const skill = skillsItem({
    tools: readable,
    skills: (agent === null ? undefined : skills.value[agent]) ?? [],
    isOff: (key) => isOff(chat, off, key),
  });
  const attach = (picked: File[]) => {
    failure.value = null;
    void files.add(picked, readable);
  };
  const started =
    onCompact !== undefined && onRename !== undefined && onFork !== undefined;
  const block = (command: Command) =>
    commandBlock({ started, running }, command);
  const matches = shut.value ? [] : commandMatches(text.value);
  // the highlight follows the list as it shrinks
  const chosen = Math.min(highlight.value, Math.max(0, matches.length - 1));
  const submit = async () => {
    const content = text.value.trim();
    if (content === "" || agent === null || busy) return;
    const named = commandOf(content);
    if (named === null && (!ready || !placed || files.busy)) return;
    failure.value = null;
    const sent = text.value;
    // a slash command carries no files and clears none
    const uploads = named === null ? files.ids : [];
    try {
      if (named !== null) {
        await runCommand(named, block(named.command), {
          onCompact,
          onRename,
          onFork,
        });
      } else await onSend(content, agent, uploads);
      // the send claimed them; the log of what was skipped goes too
      // this composer may be gone by now (a new chat navigates away), so
      // the stored draft is what loses them
      if (named === null) {
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
  const context = readout(usage);
  // a chat not started yet has the page to itself, so the box shows
  // two lines at rest; in a chat the transcript needs the room
  const tall = !("sessionId" in scope);
  const placeholder =
    agents !== null && list.length === 0
      ? "No agent yet: an admin adds one first"
      : running
        ? "Replying"
        : idle;
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
      <textarea
        ref={input}
        class="composer-text"
        name="message"
        rows={tall ? 2 : 1}
        placeholder={placeholder}
        aria-label="Message"
        disabled={agents !== null && list.length === 0}
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
          if (matches.length > 0) {
            const move =
              ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : 0;
            if (move !== 0) {
              ev.preventDefault();
              highlight.value = moveHighlight(chosen, matches.length, move);
              return;
            }
            if (ev.key === "Escape") {
              ev.preventDefault();
              shut.value = true;
              return;
            }
            const fill = commandFill(matches[chosen]!);
            if (
              ev.key === "Tab" ||
              (ev.key === "Enter" && text.value !== fill)
            ) {
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
          onPick={(command) => {
            text.value = commandFill(command);
            writeDraftText(key, text.value);
            input.current?.focus();
          }}
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
          onFiles={attach}
          web={web}
          onWeb={() => flip(chat, off, WEB)}
          visuals={visuals}
          onVisuals={() => flip(chat, off, VISUALIZE)}
          servers={mcp}
          skills={skill}
          onFlip={(key) => flip(chat, off, key)}
        />
        {project && (
          <ProjectPicker
            projects={project.projects}
            projectId={project.projectId}
            onPick={project.onPick}
          />
        )}
        <AgentPicker
          agents={list}
          agentId={agent}
          onPick={
            fixed
              ? undefined
              : (id) => {
                  picked.value = id;
                }
          }
        />
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
        <button
          type="button"
          class={`composer-send${running ? " composer-stop" : ""}`}
          aria-label={running ? "Stop" : "Send"}
          disabled={
            running
              ? false
              : !ready || !placed || files.busy || text.value.trim() === ""
          }
          onClick={() => {
            if (running) {
              onStop().catch((err) => {
                failure.value = says(err);
              });
            } else void submit();
          }}
        >
          <Icon name={running ? "stop" : "send"} size={16} />
        </button>
      </div>
    </div>
  );
}
