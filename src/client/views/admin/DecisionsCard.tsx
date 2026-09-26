// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Decisions card on the agents page: a row per question a feature
// asks a decider, its title over what it reads and, faint, "off" or
// who answers, and "custom" while an option is the admin's own. A row
// opens in place into its form (DecisionForm.tsx). With no deciders
// the rows stay, said to be off until one is added.

import { useSignal } from "@preact/signals";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import type { DecisionSummary } from "../../../shared/contracts/decision.ts";
import { deciders } from "../../data/deciders.ts";
import { decisions, decisionsError } from "../../data/decisions.ts";
import { Icon } from "../../lib/icons.tsx";
import {
  RowsAvatar,
  RowsCard,
  RowsFailed,
  RowsMeta,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { DecisionForm } from "./DecisionForm.tsx";
import { DECISION_WORDS, decisionMeta } from "./Decisions.model.ts";

function DecisionRow({
  decision,
  list,
  open,
  onToggle,
}: {
  decision: DecisionSummary;
  list: DeciderSummary[];
  open: boolean;
  onToggle: () => void;
}) {
  const words = DECISION_WORDS[decision.id];
  const meta = decisionMeta(decision, list);
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      off={!decision.enabled || list.length === 0}
      head={
        <>
          <RowsAvatar lit={open}>
            <Icon name={words.icon} size={15} />
          </RowsAvatar>
          <RowsTitle name={words.title} sub={words.sub} />
          <RowsMeta short={meta.short}>{meta.long}</RowsMeta>
        </>
      }
    >
      <DecisionForm decision={decision} deciders={list} onDone={onToggle} />
    </RowsOpen>
  );
}

export function DecisionsCard() {
  const list = decisions.value;
  const error = decisionsError.value;
  const known = deciders.value ?? [];
  const open = useSignal<string | null>(null);
  return (
    <RowsCard label="Decisions">
      {(list ?? []).map((d) => (
        <DecisionRow
          key={d.id}
          decision={d}
          list={known}
          open={open.value === d.id}
          onToggle={() => {
            open.value = open.value === d.id ? null : d.id;
          }}
        />
      ))}
      {error !== null && <RowsFailed failure={error} />}
    </RowsCard>
  );
}
