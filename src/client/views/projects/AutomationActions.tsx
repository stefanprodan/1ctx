// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The automation page's buttons over its runs. Anyone in the project
// runs, suspends and resumes; Edit and Delete are for whoever may change
// the automation, and Delete asks once, in place.

import { useSignal } from "@preact/signals";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";
import { navigate } from "../../app/router.ts";
import {
  deleteAutomation,
  runAutomation,
  suspendAutomation,
} from "../../data/automations.ts";
import { reason } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";

// Run now at the left; Suspend or Resume, Edit and Delete at the right,
// the last two for whoever may change it. A refusal shows on its own
// line under them
export function AutomationActions({
  automation,
  editable,
  onFailure,
}: {
  automation: AutomationSummary;
  editable: boolean;
  onFailure: (text: string | null) => void;
}) {
  const busy = useSignal<"run" | "suspend" | "delete" | null>(null);
  // Delete asks once, in place: the button turns into the confirmation
  const asking = useSignal(false);
  const act = async (
    which: "run" | "suspend" | "delete",
    call: () => Promise<unknown>,
  ) => {
    if (busy.value !== null) return;
    busy.value = which;
    onFailure(null);
    try {
      await call();
    } catch (err) {
      onFailure(reason(err));
    }
    busy.value = null;
  };
  const suspended = automation.suspendedAt !== null;
  const running = automation.lastRunStatus === "running";
  const off = busy.value !== null;
  return (
    <div class="automations-actions">
      <button
        type="button"
        class="btn btn-small btn-primary"
        disabled={off || running}
        title={running ? "A run is on its way" : undefined}
        onClick={() => void act("run", () => runAutomation(automation.id))}
      >
        <Icon name="play" size={12} />
        {busy.value === "run" ? "Starting" : "Run now"}
      </button>
      <div class="automations-actions-end">
        <button
          type="button"
          class="btn btn-small"
          disabled={off}
          onClick={() =>
            void act("suspend", () =>
              suspendAutomation(automation.id, !suspended),
            )
          }
        >
          <Icon name={suspended ? "play" : "pause"} size={12} />
          {suspended ? "Resume" : "Suspend"}
        </button>
        {editable && (
          <a class="btn btn-small" href={`/automations/${automation.id}/edit`}>
            <Icon name="pencil" size={12} />
            Edit
          </a>
        )}
        {editable &&
          (asking.value ? (
            <>
              <button
                type="button"
                class="btn btn-small"
                disabled={off}
                onClick={() => {
                  asking.value = false;
                }}
              >
                Keep
              </button>
              <button
                type="button"
                class="btn btn-small btn-danger"
                disabled={off || running}
                title={running ? "Stop the run first" : undefined}
                onClick={() =>
                  void act("delete", async () => {
                    await deleteAutomation(automation.id);
                    navigate(`/projects/${automation.projectId}/automations`);
                  })
                }
              >
                <Icon name="trash" size={12} />
                {busy.value === "delete" ? "Deleting" : "Delete, runs stay"}
              </button>
            </>
          ) : (
            <button
              type="button"
              class="btn btn-small"
              disabled={off}
              onClick={() => {
                asking.value = true;
              }}
            >
              <Icon name="trash" size={12} />
              Delete
            </button>
          ))}
      </div>
    </div>
  );
}
