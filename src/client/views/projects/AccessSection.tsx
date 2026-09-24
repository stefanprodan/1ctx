// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The task editor's Access step: whether runs reach the web, with a
// switch per credential of the project under it, and whether they may
// draw visuals, then a switch per MCP server and per skill of the picked
// agent. A switch that cannot be flipped is off and says why.

import type {
  SwitchableCredential,
  SwitchableServer,
  SwitchableSkill,
} from "../../../shared/api/sessions.ts";
import {
  credentialKey,
  mcpKey,
  skillKey,
} from "../../../shared/capabilities.ts";
import type { WebItem } from "../../composer/Add.model.ts";
import { Icon, type IconName } from "../../lib/icons.tsx";
import {
  RowsAvatar,
  RowsLine,
  RowsList,
  RowsMeta,
  RowsSwitch,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Section } from "../../ui/Section.tsx";

// one labelled list of switches, on unless its key is in `off`; while
// `blocked` says why, every one is off and faint
function Switches({
  label,
  icon,
  rows,
  off,
  onFlip,
  disabled,
  blocked = null,
}: {
  label: string;
  icon: IconName;
  rows: { key: string; name: string; meta: string | null }[];
  off: readonly string[];
  onFlip: (key: string) => void;
  disabled: boolean;
  blocked?: string | null;
}) {
  if (rows.length === 0) return null;
  return (
    <div class="field">
      <span class="label">{label}</span>
      <RowsList>
        {rows.map((row) => (
          <RowsLine key={row.key} flush off={blocked !== null}>
            <RowsAvatar>
              <Icon name={icon} size={14} />
            </RowsAvatar>
            <RowsTitle name={row.name} mono />
            {row.meta !== null && <RowsMeta>{row.meta}</RowsMeta>}
            <RowsSwitch
              on={blocked === null && !off.includes(row.key)}
              label={row.name}
              disabled={disabled || blocked !== null}
              onClick={() => onFlip(row.key)}
            />
          </RowsLine>
        ))}
      </RowsList>
      {blocked !== null && <span class="hint">{blocked}</span>}
    </div>
  );
}

// "The web and the agent's MCP servers and skills", by what is listed
function words(servers: number, skills: number): string {
  const has = [
    ...(servers > 0 ? ["MCP servers"] : []),
    ...(skills > 0 ? ["skills"] : []),
  ];
  return has.length === 0
    ? "Fetch, search and curl"
    : `The web and the agent's ${has.join(" and ")}`;
}

export function AccessSection({
  web,
  webOn,
  onWeb,
  visuals,
  visualsOn,
  onVisuals,
  servers,
  mcpOff,
  onServer,
  skills,
  skillsOff,
  onSkill,
  credentials,
  credentialsOff,
  onCredential,
  disabled,
}: {
  web: WebItem;
  // the draft has web access on
  webOn: boolean;
  onWeb: () => void;
  visuals: WebItem;
  // the draft has visuals on
  visualsOn: boolean;
  onVisuals: () => void;
  // the picked agent's servers, none when its model takes no tools
  servers: readonly SwitchableServer[];
  mcpOff: readonly string[];
  onServer: (key: string) => void;
  // the picked agent's skills, none when its model takes no tools
  skills: readonly SwitchableSkill[];
  skillsOff: readonly string[];
  onSkill: (key: string) => void;
  // the project's, whatever the agent
  credentials: readonly SwitchableCredential[];
  credentialsOff: readonly string[];
  onCredential: (key: string) => void;
  disabled: boolean;
}) {
  const on = web.on && webOn;
  const drawing = visuals.on && visualsOn;
  return (
    <Section title="Access" text={words(servers.length, skills.length)}>
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
        <Switches
          label="Credentials"
          icon="key"
          rows={credentials.map((credential) => ({
            key: credentialKey(credential.id),
            name: credential.name,
            meta: null,
          }))}
          off={credentialsOff}
          onFlip={onCredential}
          disabled={disabled}
          blocked={on ? null : (web.reason ?? "Web access is off")}
        />
        <div class="field">
          <div class="automations-web">
            <RowsSwitch
              on={drawing}
              label="Visuals"
              disabled={disabled || !visuals.live}
              onClick={onVisuals}
            />
            <span>
              {drawing ? "Runs can draw visuals" : "Runs cannot draw visuals"}
            </span>
          </div>
          {visuals.reason !== null && (
            <span class="hint">{visuals.reason}</span>
          )}
        </div>
        <Switches
          label="MCP servers"
          icon="mcp"
          rows={servers.map((server) => ({
            key: mcpKey(server.id),
            name: server.name,
            meta: `${server.tools} tools`,
          }))}
          off={mcpOff}
          onFlip={onServer}
          disabled={disabled}
        />
        <Switches
          label="Skills"
          icon="skill"
          rows={skills.map((skill) => ({
            key: skillKey(skill.id),
            name: skill.name,
            meta: null,
          }))}
          off={skillsOff}
          onFlip={onSkill}
          disabled={disabled}
        />
      </div>
    </Section>
  );
}
