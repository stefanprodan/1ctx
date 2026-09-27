// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a task keeps its runs from: the set its editor saves, from the
// switches it shows, and the names its page's aside says.

import type {
  SwitchableCredential,
  SwitchableServer,
  SwitchableSkill,
} from "../../../shared/api/sessions.ts";
import {
  credentialKey,
  KNOWLEDGE,
  mcpKey,
  skillKey,
  VISUALIZE,
  WEB,
} from "../../../shared/capabilities.ts";
import type { AutomationSummary } from "../../../shared/contracts/automation.ts";

// the editor's switches, as its draft holds them
export type AccessDraft = {
  // its runs may reach the web, while the instance lets them
  web: boolean;
  // its runs may call visualize, while the admin's Visuals row is on
  visuals: boolean;
  // its runs may read and edit the project docs
  knowledge: boolean;
  // the keys of the MCP servers its runs go without
  mcpOff: readonly string[];
  // the keys of the skills its runs go without
  skillsOff: readonly string[];
  // the keys of the project's credentials its runs go without
  credentialsOff: readonly string[];
};

// the saved set: a key of a server, a skill or a credential not shown
// is dropped, since nothing on the page could turn it back on
export function disabledOf(
  d: AccessDraft,
  servers: readonly SwitchableServer[],
  skills: readonly SwitchableSkill[],
  credentials: readonly SwitchableCredential[],
): string[] {
  const kept = (keys: string[], off: readonly string[]) =>
    keys.filter((key) => off.includes(key));
  return [
    ...(d.web ? [] : [WEB]),
    ...(d.visuals ? [] : [VISUALIZE]),
    ...(d.knowledge ? [] : [KNOWLEDGE]),
    ...kept(
      servers.map((server) => mcpKey(server.id)),
      d.mcpOff,
    ),
    ...kept(
      skills.map((skill) => skillKey(skill.id)),
      d.skillsOff,
    ),
    ...kept(
      credentials.map((credential) => credentialKey(credential.id)),
      d.credentialsOff,
    ),
  ].sort();
}

// what the row keeps its runs from, for the page's aside: the names of
// its agent's servers and skills and the project's credentials that are
// off, in name order. With the web off every credential goes with it,
// so none is named
export function accessOf(
  a: Pick<AutomationSummary, "disabledCapabilities">,
  servers: readonly SwitchableServer[],
  skills: readonly SwitchableSkill[] = [],
  credentials: readonly SwitchableCredential[] = [],
): {
  web: boolean;
  visuals: boolean;
  knowledge: boolean;
  mcpOff: string[];
  skillsOff: string[];
  credentialsOff: string[];
} {
  const web = !a.disabledCapabilities.includes(WEB);
  return {
    web,
    visuals: !a.disabledCapabilities.includes(VISUALIZE),
    knowledge: !a.disabledCapabilities.includes(KNOWLEDGE),
    mcpOff: servers
      .filter((server) => a.disabledCapabilities.includes(mcpKey(server.id)))
      .map((server) => server.name)
      .sort(),
    skillsOff: skills
      .filter((skill) => a.disabledCapabilities.includes(skillKey(skill.id)))
      .map((skill) => skill.name)
      .sort(),
    credentialsOff: web
      ? credentials
          .filter((c) => a.disabledCapabilities.includes(credentialKey(c.id)))
          .map((c) => c.name)
          .sort()
      : [],
  };
}
