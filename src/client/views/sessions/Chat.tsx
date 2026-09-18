// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One chat: the crumb is its project, the title its own and opens the
// menu, with Delete for the chat's owner and for an admin, as the
// server allows; /rename in the composer
// changes the title; the transcript
// flows down the page and the composer stays at the bottom of the
// window in the transcript's foot. A fork names its source over the
// transcript. A run names its automation there and has no composer, no
// Regenerate and no /compact: its foot is its state, with Stop while it
// runs, and Fork waits until it is done or stopped. Leaving the page
// ends the watch on its session, unless the next chat's load already
// owns the entity, as it does when a chat moves to its fork.

import { useEffect } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import { Composer } from "../../composer/Composer.tsx";
import { automations } from "../../data/automations.ts";
import { forkSession } from "../../data/fork.ts";
import { me } from "../../data/me.ts";
import { project, projects } from "../../data/projects.ts";
import {
  compactSession,
  deleteSession,
  leaveSession,
  live,
  markdownHref,
  projectAgents,
  regenerateSession,
  renameSession,
  sending,
  sendMessage,
  session,
  sessionError,
  stopSession,
} from "../../data/sessions.ts";
import { Icon } from "../../lib/icons.tsx";
import { groupRows } from "../../transcript/rows.ts";
import { Transcript } from "../../transcript/Transcript.tsx";
import { Page } from "../../ui/Page.tsx";
import { Menu } from "./Menu.tsx";
import { RunFoot } from "./RunFoot.tsx";
import "./chat.css";

export function Chat({ params }: { params: Params }) {
  const id = params.id ?? "";
  const detail = session.value;
  const shown = detail !== null && detail.session.id === id ? detail : null;
  useEffect(() => () => leaveSession(id), [id]);
  const projectId = shown?.session.projectId ?? null;
  const row = project.value;
  const listed =
    (row !== null && row.id === projectId ? row : null) ??
    projects.value?.find((p) => p.id === projectId) ??
    null;
  const projectName = listed?.name ?? "Project";
  const user = me.value;
  const members = row !== null && row.id === projectId ? row.members : [];
  const authorOf = (userId: string | null) => {
    const known =
      (userId !== null && user?.id === userId ? user : null) ??
      members.find((m) => m.id === userId) ??
      null;
    return known === null
      ? { name: "someone", username: null }
      : { name: known.fullName, username: known.username };
  };
  const agents = projectAgents.value ?? [];
  const agentOf = (agentId: string | null) =>
    agents.find((a) => a.id === (agentId ?? shown?.session.agentId)) ?? null;
  const run = shown?.session.origin === "automation";
  // a run is forked whole from its foot, a chat at any settled turn
  const lastTurn = shown?.messages.findLast(
    (m) => m.kind === "user" || (m.kind === "reply" && m.slot === "answer"),
  );
  const from = shown?.forkedFrom ?? null;
  const automation = run
    ? (automations.value?.find((a) => a.id === shown?.session.automationId) ??
      null)
    : null;
  return (
    <Page
      crumb={projectName}
      crumbHref={projectId === null ? undefined : `/projects/${projectId}`}
      title={shown?.session.title ?? "Chat"}
      menu={
        shown !== null ? (
          <Menu
            key={shown.session.id}
            title={shown.session.title}
            noun={run ? "run" : "chat"}
            running={shown.session.status === "running" || sending.value}
            download={markdownHref(shown.session.id)}
            onDelete={
              user?.id === shown.session.ownerId || user?.role === "admin"
                ? () => deleteSession(shown.session.id, shown.session.projectId)
                : undefined
            }
            onRename={
              !run &&
              (user?.id === shown.session.ownerId || user?.role === "admin")
                ? (title) => renameSession(shown.session.id, title)
                : undefined
            }
          />
        ) : undefined
      }
      loading={shown === null && sessionError.value === null}
      error={sessionError.value}
      flush
    >
      {shown && (
        <div class="chat">
          {from !== null && (
            <p class="chat-run">
              <Icon name="fork" size={12} />
              <span class="chat-run-label">Forked from</span>
              {from.title === null ? (
                <span>
                  a deleted {from.origin === "automation" ? "run" : "chat"}
                </span>
              ) : (
                <a class="chat-run-link" href={`/chat/${from.id}`}>
                  {from.title}
                </a>
              )}
            </p>
          )}
          {run && (
            <p class="chat-run">
              <Icon name="clock" size={12} />
              <span class="chat-run-label">Run of</span>
              {automation === null ? (
                <span>
                  {shown.session.automationId === null ||
                  automations.value !== null
                    ? "a deleted automation"
                    : "an automation"}
                </span>
              ) : (
                <a class="chat-run-link" href={`/automations/${automation.id}`}>
                  {automation.name}
                </a>
              )}
            </p>
          )}
          <Transcript
            sessionId={shown.session.id}
            nodes={groupRows(shown.messages, shown.send)}
            live={live.value}
            agentOf={agentOf}
            authorOf={authorOf}
            onRegenerate={
              run || shown.session.status === "running" || sending.value
                ? undefined
                : () => void regenerateSession(shown.session.id)
            }
            fork={
              run
                ? undefined
                : {
                    agents,
                    agentId: shown.session.agentId,
                    onFork: (messageId, agentId) =>
                      forkSession(shown.session.id, messageId, agentId),
                  }
            }
            foot={
              run ? (
                <RunFoot
                  row={{
                    session: shown.session,
                    agent: null,
                    send: shown.send,
                    last: null,
                    automation: null,
                    runBy: null,
                  }}
                  onStop={() => stopSession(shown.session.id)}
                  fork={
                    lastTurn === undefined
                      ? undefined
                      : {
                          agents,
                          onFork: (agentId) =>
                            forkSession(shown.session.id, lastTurn.id, agentId),
                        }
                  }
                />
              ) : (
                <Composer
                  scope={{ sessionId: shown.session.id }}
                  agents={projectAgents.value}
                  agentId={shown.session.agentId}
                  running={shown.session.status === "running"}
                  busy={sending.value}
                  usage={shown.session.usage}
                  onSend={(text) => sendMessage(shown.session.id, text)}
                  onStop={() => stopSession(shown.session.id)}
                  onCompact={() => compactSession(shown.session.id)}
                  onRename={(title) => renameSession(shown.session.id, title)}
                  onFork={(title) =>
                    lastTurn === undefined
                      ? Promise.reject(new Error("nothing to fork yet"))
                      : forkSession(
                          shown.session.id,
                          lastTurn.id,
                          shown.session.agentId,
                          title,
                        )
                  }
                />
              )
            }
          />
        </div>
      )}
    </Page>
  );
}
