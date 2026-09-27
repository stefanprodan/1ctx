// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Deciders card on the agents page: a row per decider, the name
// over the model and, faint, "default" on the one every feature asks,
// the provider, the window and the input price. A row opens in place
// into its form; New decider opens an empty one at the top, off until
// a provider can serve decisions. What they are asked is the Decisions
// card's (DecisionsCard.tsx).

import { useSignal } from "@preact/signals";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import { deciders, decidersError } from "../../data/deciders.ts";
import { Icon } from "../../lib/icons.tsx";
import { byName, matches } from "../../lib/search.ts";
import {
  RowsAdd,
  RowsAvatar,
  RowsCard,
  RowsFailed,
  RowsMeta,
  RowsNew,
  RowsNote,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { DeciderForm } from "./DeciderForm.tsx";
import {
  deciderMeta,
  deciderProviders,
  NO_DECIDERS,
} from "./Deciders.model.ts";

function DeciderRow({
  decider,
  providers,
  open,
  onToggle,
}: {
  decider: DeciderSummary;
  providers: ProviderSummary[];
  open: boolean;
  onToggle: () => void;
}) {
  const provider = providers.find((p) => p.id === decider.providerId);
  const facts = deciderMeta(decider);
  const mark = decider.default ? "default" : "";
  const meta = [mark, provider?.name ?? "?", facts]
    .filter((s) => s !== "")
    .join(" · ");
  // a phone shows the default word, the window and the price
  const short = [mark, facts].filter((s) => s !== "").join(" · ");
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      head={
        <>
          <RowsAvatar lit={open}>
            <Icon name="check" size={15} />
          </RowsAvatar>
          <RowsTitle name={decider.name} sub={decider.model} mono />
          <RowsMeta short={short}>{meta}</RowsMeta>
        </>
      }
    >
      <DeciderForm decider={decider} providers={providers} onDone={onToggle} />
    </RowsOpen>
  );
}

export function DecidersCard({ providers }: { providers: ProviderSummary[] }) {
  const list = deciders.value;
  const error = decidersError.value;
  const adding = useSignal(false);
  const open = useSignal<string | null>(null);
  const q = useSignal("");
  const shown = byName(list ?? []).filter((d) =>
    matches(q.value, [
      d.name,
      d.model,
      providers.find((p) => p.id === d.providerId)?.name ?? "",
    ]),
  );
  return (
    <RowsCard
      label="Deciders"
      search={
        <Search
          value={q.value}
          onChange={(next) => {
            q.value = next;
          }}
          placeholder="Search deciders"
        />
      }
      action={
        <RowsAdd
          label="New decider"
          disabled={
            adding.value ||
            list === null ||
            deciderProviders(providers).length === 0
          }
          onClick={() => {
            adding.value = true;
            open.value = null;
          }}
        />
      }
    >
      {adding.value && (
        <RowsNew>
          <DeciderForm
            decider={null}
            providers={providers}
            onDone={() => {
              adding.value = false;
            }}
          />
        </RowsNew>
      )}
      {list?.length === 0 && !adding.value && (
        <RowsNote>{NO_DECIDERS}</RowsNote>
      )}
      {q.value.trim() !== "" && shown.length === 0 && (
        <RowsNote>No deciders found</RowsNote>
      )}
      {shown.map((d) => (
        <DeciderRow
          key={d.id}
          decider={d}
          providers={providers}
          open={open.value === d.id}
          onToggle={() => {
            open.value = open.value === d.id ? null : d.id;
            adding.value = false;
          }}
        />
      ))}
      {error !== null && <RowsFailed failure={error} />}
    </RowsCard>
  );
}
