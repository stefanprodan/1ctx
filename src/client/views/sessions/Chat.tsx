// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One chat: the crumb is its project, the title its own; the transcript
// flows down the page and the composer stays at the bottom of the
// window in the transcript's foot. Leaving the page ends the watch on
// its session.

import { useEffect } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import { Composer } from "../../composer/Composer.tsx";
import { me } from "../../data/me.ts";
import { project, projects } from "../../data/projects.ts";
import {
  leaveSession,
  live,
  projectAgents,
  regenerateSession,
  sending,
  sendMessage,
  session,
  sessionError,
  stopSession,
} from "../../data/sessions.ts";
import { groupRows } from "../../transcript/rows.ts";
import { Transcript } from "../../transcript/Transcript.tsx";
import { Page } from "../../ui/Page.tsx";
import "./chat.css";

export function Chat({ params }: { params: Params }) {
  const id = params.id ?? "";
  const detail = session.value;
  const shown = detail !== null && detail.session.id === id ? detail : null;
  useEffect(() => () => leaveSession(), [id]);
  const projectId = shown?.session.projectId ?? null;
  const row = project.value;
  const projectName =
    (row !== null && row.id === projectId ? row : null)?.name ??
    projects.value?.find((p) => p.id === projectId)?.name ??
    "Project";
  const user = me.value;
  const members = row !== null && row.id === projectId ? row.members : [];
  const authorOf = (userId: string | null) =>
    (userId !== null && user?.id === userId ? user.fullName : null) ??
    members.find((m) => m.id === userId)?.fullName ??
    "someone";
  const agent =
    projectAgents.value?.find((a) => a.id === shown?.session.agentId) ?? null;
  return (
    <Page
      crumb={projectName}
      crumbHref={projectId === null ? undefined : `/projects/${projectId}`}
      title={shown?.session.title ?? "Chat"}
      loading={shown === null && sessionError.value === null}
      error={sessionError.value}
      flush
    >
      {shown && (
        <div class="chat">
          <Transcript
            sessionId={shown.session.id}
            nodes={groupRows(shown.messages, shown.send)}
            live={live.value}
            agent={agent}
            authorOf={authorOf}
            onRegenerate={
              shown.session.status === "running" || sending.value
                ? undefined
                : () => void regenerateSession(shown.session.id)
            }
            foot={
              <Composer
                scope={{ sessionId: shown.session.id }}
                agents={projectAgents.value}
                agentId={shown.session.agentId}
                running={shown.session.status === "running"}
                busy={sending.value}
                usage={shown.session.usage}
                onSend={(text) => sendMessage(shown.session.id, text)}
                onStop={() => stopSession(shown.session.id)}
              />
            }
          />
        </div>
      )}
    </Page>
  );
}
