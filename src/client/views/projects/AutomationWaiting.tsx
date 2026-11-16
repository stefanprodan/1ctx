// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An automation's page while its row, project and agents load: the
// summary card, the actions' buttons, the tabs and the tab's card in
// bones, beside the aside's sections, so the page lands in this shape.
// An open alert lands over the summary only with the row, as it is
// rare and its size is not known before.

import type { RunFilter } from "../../../shared/words.ts";
import { automationHref } from "../../lib/hrefs.ts";
import { Bone } from "../../ui/Bones.tsx";
import { RowsCard, RowsFilters, RowsWaiting } from "../../ui/Rows.tsx";
import { Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { AsideBones } from "../admin/AdminWaiting.tsx";
import { NoteWaiting } from "../memory/Note.tsx";
import "./automations.css";

export const RUN_FILTERS: { value: RunFilter | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "manual", label: "Manual" },
  { value: "attention", label: "Flagged" },
];

// the Runs card's filter links, the same while it loads and once it lands
export function RunFilters({
  id,
  filter,
}: {
  id: string;
  filter: RunFilter | null;
}) {
  return (
    <RowsFilters
      label="Filter runs"
      filters={RUN_FILTERS.map((f) => ({
        label: f.label,
        on: f.value === filter,
        href: `${automationHref(id)}${f.value === null ? "" : `?runs=${f.value}`}`,
      }))}
    />
  );
}

export function AutomationWaiting({
  id,
  memory,
  filter,
}: {
  id: string;
  // the address is the Memory tab's, so the automation keeps a note
  memory: boolean;
  filter: RunFilter | null;
}) {
  const runs = automationHref(id);
  return (
    <Split
      aside={
        <>
          <AsideBones label="Next runs" lines={1} />
          <AsideBones label="History" lines={2} />
          <AsideBones label="Setup" lines={5} />
        </>
      }
    >
      <section
        class="card automations-summary bones-wait"
        role="status"
        aria-label="Loading the automation"
      >
        <p class="automations-summary-line bones-lines-line" aria-hidden="true">
          <Bone kind="line" at={0} width={36} />
        </p>
        <div class="automations-summary-text" aria-hidden="true">
          <p class="automations-summary-body">
            <span class="bones-lines-line">
              <Bone kind="line" at={1} width={82} />
            </span>
            <span class="bones-lines-line">
              <Bone kind="line" at={2} width={48} />
            </span>
          </p>
        </div>
        <div class="automations-summary-foot" aria-hidden="true">
          <p class="automations-summary-next bones-lines-line">
            <Bone kind="line" at={3} class="automations-next-bone" />
          </p>
        </div>
      </section>
      <div class="automations-actions bones-wait" aria-hidden="true">
        <Bone kind="button" at={4} class="bones-bone-small" />
        <div class="automations-actions-end">
          <Bone kind="button" at={5} class="bones-bone-small" />
          <Bone kind="button" at={6} class="bones-bone-small" />
          <Bone kind="button" at={7} class="bones-bone-small" />
        </div>
      </div>
      <Tabs
        tabs={[
          { label: "Runs", href: runs },
          ...(memory ? [{ label: "Memory", href: `${runs}/memory` }] : []),
        ]}
        active={memory ? `${runs}/memory` : runs}
      />
      {memory ? (
        <NoteWaiting />
      ) : (
        <RowsCard label="Runs" action={<RunFilters id={id} filter={filter} />}>
          <RowsWaiting shape="icon" label="Loading runs" />
        </RowsCard>
      )}
    </Split>
  );
}
