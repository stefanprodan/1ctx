// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Setup card: a tab per agent in its head, and under it that
// agent's MCP server and the skill. A tab is an address on the one
// Connect agents view, so a key shown once above stays while the user
// moves between tabs.

import { path } from "../../app/router.ts";
import { RowsBlock, RowsCard } from "../../ui/Rows.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { hrefOf, setupAgent, setupLines, setupTabs } from "./Setup.model.ts";
import { Snippet } from "./Snippet.tsx";
import "./connect.css";

export function Setup() {
  const agent = setupAgent(path.value);
  const origin = globalThis.location?.origin ?? "";
  return (
    <RowsCard
      label="Setup"
      tabs={<Tabs tabs={setupTabs()} active={hrefOf(agent)} head />}
    >
      <RowsBlock>
        <div class="connect-setup">
          {setupLines(origin, agent).map((line) => (
            <Snippet
              key={`${agent}-${line.label}`}
              label={line.label}
              text={line.text}
              hint={line.hint}
            />
          ))}
        </div>
      </RowsBlock>
    </RowsCard>
  );
}
