// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Feed tab: the composer that starts a chat in it, then
// its sessions as the stream, searched like Home's. The rows drop the
// project name, since the page is the project.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import { navigate, query } from "../../app/router.ts";
import { Composer } from "../../composer/Composer.tsx";
import {
  createSession,
  list,
  projectAgents,
  sending,
} from "../../data/sessions.ts";
import { tickMs } from "../../stream/Row.model.ts";
import { Stream } from "../../stream/Stream.tsx";
import {
  emptyLine,
  originOf,
  searchHref,
  searchOf,
} from "../home/Home.model.ts";
import { Frame } from "./Frame.tsx";

export function Project({ params }: { params: Params }) {
  const id = params.id ?? "";
  const rows = list.value;
  const now = useSignal(Date.now());
  const tick = tickMs(rows);
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, tick);
    return () => clearInterval(timer);
  }, [tick, now]);
  const q = searchOf(query.value);
  const origin = originOf(query.value);
  return (
    <Frame id={id} tab="feed">
      {(shown) => (
        <>
          <Composer
            scope={{ projectId: shown.id }}
            agents={projectAgents.value}
            agentId={null}
            placeholder={`Start a chat in ${shown.name}`}
            running={false}
            busy={sending.value}
            onSend={async (message, agentId) => {
              await createSession({ projectId: shown.id, agentId, message });
            }}
            onStop={async () => {}}
          />
          <Stream
            rows={rows}
            projectName={() => null}
            search={{
              value: q,
              onChange: (next) =>
                navigate(
                  searchHref(`/projects/${shown.id}`, next, origin),
                  true,
                ),
            }}
            filter={{
              value: origin,
              onPick: (next) =>
                navigate(searchHref(`/projects/${shown.id}`, q, next), true),
            }}
            empty={emptyLine(q, origin)}
            now={now.value}
          />
        </>
      )}
    </Frame>
  );
}
