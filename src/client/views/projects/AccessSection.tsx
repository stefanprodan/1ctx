// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The task editor's Access step: whether runs reach the web, then a
// switch per MCP server of the picked agent. A switch that cannot be
// flipped is off and says why.

import type { SwitchableServer } from "../../../shared/api/sessions.ts";
import { mcpKey } from "../../../shared/capabilities.ts";
import type { WebItem } from "../../composer/Add.model.ts";
import { Icon } from "../../lib/icons.tsx";
import {
  RowsAvatar,
  RowsLine,
  RowsList,
  RowsMeta,
  RowsSwitch,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Section } from "../../ui/Section.tsx";

export function AccessSection({
  web,
  webOn,
  onWeb,
  servers,
  mcpOff,
  onServer,
  disabled,
}: {
  web: WebItem;
  // the draft has web access on
  webOn: boolean;
  onWeb: () => void;
  // the picked agent's servers, none when its model takes no tools
  servers: readonly SwitchableServer[];
  mcpOff: readonly string[];
  onServer: (key: string) => void;
  disabled: boolean;
}) {
  const on = web.on && webOn;
  return (
    <Section
      title="Access"
      text={
        servers.length === 0
          ? "Fetch, search and curl"
          : "The web and the agent's MCP servers"
      }
    >
      <div class="automations-access">
        <div class="field">
          <div class="automations-web">
            <RowsSwitch
              on={on}
              label="Web access"
              disabled={disabled || !web.live}
              onClick={onWeb}
            />
            <span>
              {on ? "Runs can reach the web" : "Runs cannot reach the web"}
            </span>
          </div>
          {web.reason !== null && <span class="hint">{web.reason}</span>}
        </div>
        {servers.length > 0 && (
          <div class="field">
            <span class="label">MCP servers</span>
            <RowsList>
              {servers.map((server) => {
                const key = mcpKey(server.id);
                return (
                  <RowsLine key={server.id} flush>
                    <RowsAvatar>
                      <Icon name="mcp" size={14} />
                    </RowsAvatar>
                    <RowsTitle name={server.name} mono />
                    <RowsMeta>{server.tools} tools</RowsMeta>
                    <RowsSwitch
                      on={!mcpOff.includes(key)}
                      label={server.name}
                      disabled={disabled}
                      onClick={() => onServer(key)}
                    />
                  </RowsLine>
                );
              })}
            </RowsList>
          </div>
        )}
      </div>
    </Section>
  );
}
