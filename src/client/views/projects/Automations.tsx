// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Automations tab: one card, a row per automation with its
// schedule in words, when it fires next and how the last run ended, the
// agent at the right. A row opens in place into Run now, Suspend or
// Resume, which anyone in the project may press, the fields, and the
// last runs as stream rows. New automation opens an empty form at the
// top. The words are Automations.model.ts.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { AgentSummary } from "../../../shared/contracts/agent.ts";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import type { ProjectKind } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import {
  automations,
  automationsError,
  closeRuns,
  loadRuns,
  runAutomation,
  runDeadlineMs,
  runs,
  suspendAutomation,
} from "../../data/automations.ts";
import { me } from "../../data/me.ts";
import { projectAgents } from "../../data/sessions.ts";
import { reason } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { tickMs } from "../../stream/Row.model.ts";
import { Stream } from "../../stream/Stream.tsx";
import {
  RowsAdd,
  RowsAvatar,
  RowsCard,
  RowsMeta,
  RowsNew,
  RowsNote,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AutomationForm } from "./AutomationForm.tsx";
import { canChange, eventNote, metaLine } from "./Automations.model.ts";
import { Frame } from "./Frame.tsx";
import "./automations.css";

// Run now and Suspend or Resume, with the refusal beside them
function Actions({ automation }: { automation: AutomationSummary }) {
  const busy = useSignal<"run" | "suspend" | null>(null);
  const failure = useSignal<string | null>(null);
  const act = async (
    which: "run" | "suspend",
    call: () => Promise<unknown>,
  ) => {
    if (busy.value !== null) return;
    busy.value = which;
    failure.value = null;
    try {
      await call();
    } catch (err) {
      failure.value = reason(err);
    }
    busy.value = null;
  };
  const suspended = automation.suspendedAt !== null;
  const running = automation.lastRunStatus === "running";
  return (
    <div class="automations-actions">
      <button
        type="button"
        class="btn btn-small"
        disabled={busy.value !== null || running}
        title={running ? "A run is on its way" : undefined}
        onClick={() => void act("run", () => runAutomation(automation.id))}
      >
        <Icon name="play" size={12} />
        {busy.value === "run" ? "Starting" : "Run now"}
      </button>
      <button
        type="button"
        class="btn btn-small"
        disabled={busy.value !== null}
        onClick={() =>
          void act("suspend", () =>
            suspendAutomation(automation.id, !suspended),
          )
        }
      >
        <Icon name={suspended ? "play" : "pause"} size={12} />
        {suspended ? "Resume" : "Suspend"}
      </button>
      {failure.value !== null && (
        <span class="automations-note error">{failure.value}</span>
      )}
    </div>
  );
}

function AutomationRow({
  automation,
  kind,
  agents,
  open,
  now,
  onToggle,
}: {
  automation: AutomationSummary;
  kind: ProjectKind;
  agents: AgentSummary[];
  open: boolean;
  now: number;
  onToggle: () => void;
}) {
  const agent = agents.find((a) => a.id === automation.agentId);
  const held = runs.value;
  const rows = held?.id === automation.id ? held.rows : null;
  const note = eventNote(automation, now);
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      off={automation.suspendedAt !== null}
      head={
        <>
          <RowsAvatar lit={open}>
            <Icon name="clock" size={15} />
          </RowsAvatar>
          <RowsTitle
            name={automation.name}
            sub={metaLine(automation, now)}
            mono
          />
          <RowsMeta>{agent?.name ?? "no agent"}</RowsMeta>
        </>
      }
    >
      <div class="automations-body">
        <Actions automation={automation} />
        {note !== null && <p class="automations-note">{note}</p>}
        <AutomationForm
          key={automation.id}
          automation={automation}
          projectId={automation.projectId}
          agents={agents}
          limitMs={runDeadlineMs.value ?? 0}
          editable={canChange(automation, me.value ?? null, kind)}
          onDone={onToggle}
        />
        <section class="automations-runs">
          <span class="label">Runs</span>
          <Stream
            rows={rows}
            projectName={() => null}
            empty="No runs yet"
            now={now}
          />
        </section>
      </div>
    </RowsOpen>
  );
}

export function Automations({ params }: { params: Params }) {
  const id = params.id ?? "";
  const list = automations.value;
  const agents = projectAgents.value;
  const open = useSignal<string | null>(null);
  const adding = useSignal(false);
  const now = useSignal(Date.now());
  const held = runs.value;
  const tick = Math.min(
    tickMs(held?.rows ?? null),
    list?.some((a) => a.lastRunStatus === "running") ? 1000 : 30_000,
  );
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, tick);
    return () => clearInterval(timer);
  }, [tick, now]);
  // the page left, or another project: no row stays open
  useEffect(() => {
    open.value = null;
    adding.value = false;
    return () => closeRuns();
  }, [id, open, adding]);
  return (
    <Frame id={id} tab="automations">
      {(shown) => (
        <RowsCard
          label="Automations"
          action={
            <RowsAdd
              label="New automation"
              disabled={adding.value || agents === null || agents.length === 0}
              onClick={() => {
                adding.value = true;
                open.value = null;
                closeRuns();
              }}
            />
          }
        >
          {adding.value && agents !== null && runDeadlineMs.value !== null && (
            <RowsNew>
              <AutomationForm
                automation={null}
                projectId={shown.id}
                agents={agents}
                limitMs={runDeadlineMs.value ?? 0}
                editable
                onDone={() => {
                  adding.value = false;
                }}
              />
            </RowsNew>
          )}
          {automationsError.value !== null ? (
            <RowsNote>{automationsError.value}</RowsNote>
          ) : list === null ||
            agents === null ||
            runDeadlineMs.value === null ? (
            <RowsNote>Loading</RowsNote>
          ) : list.length === 0 && !adding.value ? (
            <RowsNote>
              {agents.length === 0
                ? "No agents yet. An admin adds one first."
                : "No automations yet."}
            </RowsNote>
          ) : (
            list.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                kind={shown.kind}
                agents={agents}
                open={open.value === automation.id}
                now={now.value}
                onToggle={() => {
                  const next =
                    open.value === automation.id ? null : automation.id;
                  open.value = next;
                  adding.value = false;
                  if (next === null) closeRuns();
                  else void loadRuns(next);
                }}
              />
            ))
          )}
        </RowsCard>
      )}
    </Frame>
  );
}
