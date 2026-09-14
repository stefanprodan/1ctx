// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One chat: the crumb is its project, the title its own and opens the
// menu, with Delete for the chat's owner and for an admin, as the
// server allows; /rename in the composer
// changes the title; the transcript
// flows down the page and the composer stays at the bottom of the
// window in the transcript's foot. A run names its automation over the
// transcript and has no composer, no Regenerate and no /compact: its
// foot is its state, with Stop while it runs. Leaving the page ends the
// watch on its session.

import { useEffect } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import { Composer } from "../../composer/Composer.tsx";
import { automations } from "../../data/automations.ts";
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
  useEffect(() => () => leaveSession(), [id]);
  const projectId = shown?.session.projectId ?? null;
  const row = project.value;
  const listed =
    (row !== null && row.id === projectId ? row : null) ??
    projects.value?.find((p) => p.id === projectId) ??
    null;
  const projectName = listed?.name ?? "Project";
  const user = me.value;
  const members = row !== null && row.id === projectId ? row.members : [];
  const authorOf = (userId: string | null) =>
    (userId !== null && user?.id === userId ? user.fullName : null) ??
    members.find((m) => m.id === userId)?.fullName ??
    "someone";
  const agent =
    projectAgents.value?.find((a) => a.id === shown?.session.agentId) ?? null;
  const run = shown?.session.origin === "automation";
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
          />
        ) : undefined
      }
      loading={shown === null && sessionError.value === null}
      error={sessionError.value}
      flush
    >
      {shown && (
        <div class="chat">
          {run && (
            <p class="chat-run">
              <Icon name="clock" size={12} />
              <span>Run of</span>
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
            agent={agent}
            authorOf={authorOf}
            onRegenerate={
              run || shown.session.status === "running" || sending.value
                ? undefined
                : () => void regenerateSession(shown.session.id)
            }
            foot={
              run ? (
                <RunFoot
                  row={{
                    session: shown.session,
                    send: shown.send,
                    last: null,
                    automation: null,
                    runBy: null,
                  }}
                  onStop={() => stopSession(shown.session.id)}
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
                />
              )
            }
          />
        </div>
      )}
    </Page>
  );
}
