// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The top of an automation's page while its alert is open: since when
// it needs attention, how many runs, the latest reason or the decider
// that flagged them, and Dismiss,
// which anyone who sees the automation presses. Each marked run's row
// below keeps its own reason.

import { useSignal } from "@preact/signals";
import type { AutomationAlert } from "../../../shared/contracts/automation.ts";
import { dismissAlert } from "../../data/automations.ts";
import { alertSpan } from "../../feed/Row.model.ts";
import { says } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";

export function OpenAttention({
  id,
  alert,
  now,
}: {
  id: string;
  alert: AutomationAlert;
  now: number;
}) {
  const busy = useSignal(false);
  const failure = useSignal<string | null>(null);
  return (
    <section class="card automations-open">
      <Icon name="alert" size={16} class="automations-open-icon" />
      <div class="automations-open-text">
        <p class="automations-open-title">
          Needs attention {alertSpan(alert, now)}
        </p>
        {alert.reason !== null ? (
          <p class="automations-open-reason">{alert.reason}</p>
        ) : (
          // with no reason, only a decider marked its runs
          alert.by !== null && (
            <p class="automations-open-reason">
              Flagged by the @{alert.by} decider
            </p>
          )
        )}
        {failure.value !== null && (
          <p class="automations-open-reason error" role="alert">
            {failure.value}
          </p>
        )}
      </div>
      <button
        type="button"
        class="btn btn-small"
        disabled={busy.value}
        onClick={() => {
          busy.value = true;
          failure.value = null;
          dismissAlert(id)
            .catch((err) => {
              failure.value = says(err);
            })
            .finally(() => {
              busy.value = false;
            });
        }}
      >
        Dismiss
      </button>
    </section>
  );
}
