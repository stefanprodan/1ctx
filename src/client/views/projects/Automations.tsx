// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Automations tab: one card, a row per automation that
// leads to its page, with the schedule in words and the agent under
// the name and its state at the right: running, a failed last run,
// suspended or the next fire. New automation leads to the editor. The
// words are Automations.model.ts.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import { navigate } from "../../app/router.ts";
import { automations, automationsError } from "../../data/automations.ts";
import { projectAgents } from "../../data/sessions.ts";
import { Icon } from "../../lib/icons.tsx";
import {
  RowsAdd,
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsHandle,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { rowState, scheduleWords } from "./Automations.model.ts";
import { Frame } from "./Frame.tsx";
import "./automations.css";

export function Automations({ params }: { params: Params }) {
  const id = params.id ?? "";
  const list = automations.value;
  const agents = projectAgents.value;
  const now = useSignal(Date.now());
  const tick = list?.some((a) => a.lastRunStatus === "running") ? 1000 : 30_000;
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, tick);
    return () => clearInterval(timer);
  }, [tick, now]);
  return (
    <Frame id={id} tab="automations">
      {(shown) => (
        <RowsCard
          label="Scheduled tasks"
          action={
            <RowsAdd
              label="New scheduled task"
              disabled={agents === null || agents.length === 0}
              onClick={() => navigate(`/projects/${shown.id}/automations/new`)}
            />
          }
        >
          {automationsError.value !== null ? (
            <RowsNote>{automationsError.value}</RowsNote>
          ) : list === null || agents === null ? (
            <RowsNote>Loading</RowsNote>
          ) : list.length === 0 ? (
            <RowsNote>
              {agents.length === 0
                ? "No agents yet. An admin adds one first."
                : "No scheduled tasks yet."}
            </RowsNote>
          ) : (
            list.map((automation) => {
              const agent = agents.find((a) => a.id === automation.agentId);
              const state = rowState(automation, now.value);
              const status = automation.lastRunStatus ?? "none";
              return (
                <RowsGo
                  key={automation.id}
                  href={`/automations/${automation.id}`}
                >
                  <RowsAvatar>
                    <Icon
                      name={automation.suspendedAt === null ? "clock" : "pause"}
                      size={15}
                      class={
                        status === "running" || status === "failed"
                          ? `status-${status}`
                          : undefined
                      }
                    />
                  </RowsAvatar>
                  <RowsTitle
                    name={automation.name}
                    mono
                    sub={
                      <>
                        {scheduleWords(automation.schedule) ??
                          automation.schedule}
                        {" · "}
                        <RowsHandle name={agent?.name ?? "no agent"} />
                      </>
                    }
                  />
                  {state.text !== "" && (
                    <RowsMeta bad={state.bad}>{state.text}</RowsMeta>
                  )}
                </RowsGo>
              );
            })
          )}
        </RowsCard>
      )}
    </Frame>
  );
}
