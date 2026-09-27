// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A zone's overview until its board is designed: the zone's pages, each
// a row that opens it.

import { ZONES } from "../../app/zones.ts";
import { Page } from "../../ui/Page.tsx";
import { Rows, RowsCard, RowsGo, RowsTitle } from "../../ui/Rows.tsx";

export const AccessBoard = () => <ZoneBoard href="/access" />;
export const ConfigBoard = () => <ZoneBoard href="/config" />;

function ZoneBoard({ href }: { href: string }) {
  const zone = ZONES.find((z) => z.href === href)!;
  return (
    <Page crumb="" title={zone.label}>
      <Rows>
        <RowsCard label="Pages">
          {zone.pages.map((p) => (
            <RowsGo key={p.href} href={p.href}>
              <RowsTitle name={p.label} />
            </RowsGo>
          ))}
        </RowsCard>
      </Rows>
    </Page>
  );
}
