// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's, an agent's or a decider's page while it loads: who it is
// in bones, the activity's grid, and the card under its tabs, beside
// the aside's lines, so the page lands in the shape it waited in.

import { Rows, RowsCard, RowsWaiting } from "../../ui/Rows.tsx";
import { AsideBones, Split } from "../../ui/Split.tsx";
import { type Tab, Tabs } from "../../ui/Tabs.tsx";
import { WhoWaiting } from "../../ui/Who.tsx";
import { ActivityGhost } from "../projects/Activity.tsx";

export function DirectoryWaiting({
  label,
  aside,
  lines,
  card,
  tabs,
  active,
  narrow,
}: {
  // what is loading, for a screen reader: "Loading the user"
  label: string;
  // the aside's one section and its lines
  aside: string;
  lines: number;
  // the card's label, and the tabs at its head when it has them
  card: string;
  tabs?: Tab[];
  active?: string;
  // the head's lines shown only where the aside is hidden
  narrow?: number;
}) {
  return (
    <Split aside={<AsideBones label={aside} lines={lines} />}>
      <div class="directory">
        <WhoWaiting label={label} narrow={narrow} />
        <Rows>
          <ActivityGhost quiet />
        </Rows>
        <Rows>
          <RowsCard
            label={card}
            tabs={
              tabs === undefined ? undefined : (
                <Tabs tabs={tabs} active={active ?? tabs[0].href} head />
              )
            }
          >
            <RowsWaiting count={3} shape="plain" />
          </RowsCard>
        </Rows>
      </div>
    </Split>
  );
}
