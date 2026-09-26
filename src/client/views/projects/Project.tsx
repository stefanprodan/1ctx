// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Feed tab: the composer that starts a chat in it, then
// its sessions as the stream, searched like Home's. The rows drop the
// project name, since the page is the project.

import type { Params } from "../../app/params.ts";
import { Composer } from "../../composer/Composer.tsx";
import { projectAgents, sending } from "../../data/sessions.ts";
import { Feed, startChat } from "../home/Feed.tsx";
import { Frame } from "./Frame.tsx";

export function Project({ params }: { params: Params }) {
  const id = params.id ?? "";
  return (
    <Frame id={id} tab="feed">
      {(shown) => (
        <>
          <Composer
            scope={{ projectId: shown.id }}
            filesProjectId={shown.id}
            agents={projectAgents.value}
            agentId={null}
            placeholder={`Start a chat in ${shown.name}`}
            running={false}
            busy={sending.value}
            onSend={startChat(shown.id)}
            onStop={async () => {}}
          />
          <Feed path={`/projects/${shown.id}`} projectName={() => null} />
        </>
      )}
    </Frame>
  );
}
