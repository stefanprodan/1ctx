// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The task editor's Access step: one list of switches, the web with
// the project's credentials after it, visuals, the project docs, then
// the picked agent's MCP servers and skills. Each row's meta says what
// it is. A switch that cannot be flipped is off and faint, its meta
// saying why.

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

type Row = {
  key: string;
  name: string;
  icon: IconName;
  // what it is, or why it cannot be flipped
  meta: string;
  mono: boolean;
  on: boolean;
  // cannot be flipped now: off and faint
  blocked: boolean;
  onFlip: () => void;
};

// a built-in switch: its meta gives way to the reason it is locked
function builtin(
  key: string,
  name: string,
  icon: IconName,
  meta: string,
  item: WebItem,
  on: boolean,
  onFlip: () => void,
): Row {
  return {
    key,
    name,
    icon,
    meta: item.live ? meta : (item.reason ?? meta),
    mono: false,
    on: item.on && on,
    blocked: !item.live,
    onFlip,
  };
}

export function AccessSection({
  web,
  webOn,
  onWeb,
  visuals,
  visualsOn,
  onVisuals,
  knowledge,
  knowledgeOn,
  onKnowledge,
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
  knowledge: WebItem;
  // the draft has the project docs on
  knowledgeOn: boolean;
  onKnowledge: () => void;
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
  const webRow = builtin(
    "web",
    "Web access",
    "globe",
    "fetch, search and curl",
    web,
    webOn,
    onWeb,
  );
  const rows: Row[] = [
    webRow,
    ...credentials.map((credential) => {
      const key = credentialKey(credential.id);
      return {
        key,
        name: credential.name,
        icon: "key" as const,
        meta: webRow.on ? "credential" : "needs web access",
        mono: true,
        on: webRow.on && !credentialsOff.includes(key),
        blocked: !webRow.on,
        onFlip: () => onCredential(key),
      };
    }),
    builtin(
      "visualize",
      "Visuals",
      "visual",
      "charts and diagrams",
      visuals,
      visualsOn,
      onVisuals,
    ),
    builtin(
      "knowledge",
      "Knowledge",
      "folder",
      "project docs",
      knowledge,
      knowledgeOn,
      onKnowledge,
    ),
    ...servers.map((server) => {
      const key = mcpKey(server.id);
      return {
        key,
        name: server.name,
        icon: "mcp" as const,
        meta: `${server.tools} MCP tools`,
        mono: true,
        on: !mcpOff.includes(key),
        blocked: false,
        onFlip: () => onServer(key),
      };
    }),
    ...skills.map((skill) => {
      const key = skillKey(skill.id);
      return {
        key,
        name: skill.name,
        icon: "skill" as const,
        meta: "skill",
        mono: true,
        on: !skillsOff.includes(key),
        blocked: false,
        onFlip: () => onSkill(key),
      };
    }),
  ];
  return (
    <Section title="Access" text="What a run can use">
      <RowsList>
        {rows.map((row) => (
          <RowsLine key={row.key} flush off={row.blocked}>
            <RowsAvatar>
              <Icon name={row.icon} size={14} />
            </RowsAvatar>
            <RowsTitle name={row.name} mono={row.mono} />
            <RowsMeta>{row.meta}</RowsMeta>
            <RowsSwitch
              on={row.on}
              label={row.name}
              disabled={disabled || row.blocked}
              onClick={row.onFlip}
            />
          </RowsLine>
        ))}
      </RowsList>
    </Section>
  );
}
