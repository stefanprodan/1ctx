// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An admin page's first load in its landed layout: the aside's
// sections under their labels, the tabs it lands with, and its cards
// in bones, so the search, the aside and the cards are in place before
// the answer and nothing moves when it lands.

import type { ComponentChildren } from "preact";
import { Rows, RowsCard, type RowsShape, RowsWaiting } from "../../ui/Rows.tsx";
import { type CardBones, SettingWaiting } from "../../ui/SettingWaiting.tsx";
import { AsideSection, AsideWaiting, Split } from "../../ui/Split.tsx";
import { UsageSection } from "./AdminAside.tsx";

// an aside section's lines while the page loads
export function AsideBones({ label, lines }: { label: string; lines: number }) {
  return (
    <AsideSection label={label}>
      <AsideWaiting label={`Loading ${label.toLowerCase()}`} lines={lines} />
    </AsideSection>
  );
}

// the usage section an object's aside leads with, with its link
export function UsageBones({
  label,
  lines,
}: {
  label?: string;
  lines?: number;
}) {
  return (
    <UsageSection value={undefined} label={label} lines={lines}>
      {() => null}
    </UsageSection>
  );
}

const asideOf = (usage: boolean, aside: ComponentChildren) => (
  <>
    {usage && <UsageBones />}
    {aside}
  </>
);

// an object's page or a board of cards beside its aside
export function CardsWaiting({
  label,
  usage = false,
  aside,
  lead,
  cards,
}: {
  label: string;
  // the aside leads with the last 30 days' usage
  usage?: boolean;
  aside?: ComponentChildren;
  // what the stack opens with before its cards: the page's tabs
  lead?: ComponentChildren;
  cards: readonly CardBones[];
}) {
  return (
    <Split aside={asideOf(usage, aside)}>
      <SettingWaiting label={label} cards={cards} lead={lead} />
    </Split>
  );
}

// a list page: its card with the search the page lands with, which
// takes a query while the rows load, beside its aside
export function ListWaiting({
  label,
  search,
  aside,
  lead,
  class: owner,
  rows = 4,
  shape = "avatar",
}: {
  label: string;
  search: ComponentChildren;
  aside: ComponentChildren;
  // what the list opens with over its card: the page's tabs
  lead?: ComponentChildren;
  // the landed box around the lead and the card, for its spacing
  class?: string;
  rows?: number;
  shape?: RowsShape;
}) {
  const card = (
    <Rows>
      <RowsCard label={label} search={search}>
        <RowsWaiting
          count={rows}
          shape={shape}
          label={`Loading ${label.toLowerCase()}`}
        />
      </RowsCard>
    </Rows>
  );
  return (
    <Split aside={aside}>
      {owner === undefined ? (
        <>
          {lead}
          {card}
        </>
      ) : (
        <div class={owner}>
          {lead}
          {card}
        </div>
      )}
    </Split>
  );
}
