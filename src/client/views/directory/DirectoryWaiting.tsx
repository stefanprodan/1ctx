// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's, an agent's or a decider's page while it loads: who it is
// in bones, the activity's grid, and the card under its tabs, beside
// the aside's lines, so the page lands in the shape it waited in.

import { Rows, RowsCard, RowsWaiting } from "../../ui/Rows.tsx";
import { Split } from "../../ui/Split.tsx";
import { type Tab, Tabs } from "../../ui/Tabs.tsx";
import { WhoWaiting } from "../../ui/Who.tsx";
import { AsideBones } from "../admin/AdminWaiting.tsx";
import { ActivityGhost } from "../projects/Activity.tsx";

export function DirectoryWaiting({
  label,
  aside,
  lines,
  card,
  tabs,
  active,
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
}) {
  return (
    <Split aside={<AsideBones label={aside} lines={lines} />}>
      <div class="directory">
        <WhoWaiting label={label} />
        <Rows>
          <ActivityGhost />
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
            <RowsWaiting count={3} shape="plain" label={`Loading ${card}`} />
          </RowsCard>
        </Rows>
      </div>
    </Split>
  );
}
