// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The plus menu's switches for the composer's chat and agent, over the
// flips kept in data/capabilities.ts. A flip never sent goes when the
// chat does; another project drops the credential and repository flips,
// since those are the project's, and another agent the server and
// skill flips, since its servers and skills are other keys.

import { useEffect, useRef } from "preact/hooks";
import {
  CREDENTIAL,
  EMAIL,
  KNOWLEDGE,
  MCP,
  MEMORY,
  REPO,
  SKILL,
  VISUALIZE,
  WEB,
} from "../../shared/capabilities.ts";
import {
  credentials,
  dropFlips,
  dropKind,
  isOff,
  repos,
  servers,
  skills,
  switchable,
} from "../data/capabilities.ts";
import {
  agentMoved,
  emailItem,
  reposItem,
  serversItem,
  skillsItem,
  switchItem,
  webPaneItem,
} from "./Add.model.ts";

export function useSwitches({
  chat,
  off,
  agent,
  readable,
  projectId,
}: {
  chat: string | null;
  off: readonly string[];
  agent: string | null;
  readable: boolean;
  projectId: string;
}) {
  useEffect(() => () => dropFlips(chat), [chat]);
  const lastProject = useRef<string | null>(null);
  useEffect(() => {
    if (agentMoved(lastProject.current, projectId)) {
      dropKind(chat, CREDENTIAL);
      dropKind(chat, REPO);
    }
    lastProject.current = projectId;
  }, [chat, projectId]);
  const lastAgent = useRef<string | null>(null);
  useEffect(() => {
    if (agentMoved(lastAgent.current, agent)) {
      dropKind(chat, MCP);
      dropKind(chat, SKILL);
    }
    if (agent !== null) lastAgent.current = agent;
  }, [chat, agent]);
  const offKey = (key: string) => isOff(chat, off, key);
  const input = (key: string) => ({
    tools: readable,
    switchable: switchable.value,
    off: offKey(key),
  });
  const item = (key: string) => switchItem(key, input(key));
  const web = item(WEB);
  return {
    web,
    webPane: webPaneItem({
      web,
      credentials: credentials.value,
      isOff: offKey,
    }),
    visuals: item(VISUALIZE),
    knowledge: item(KNOWLEDGE),
    memory: item(MEMORY),
    email: emailItem(input(EMAIL)),
    servers: serversItem({
      tools: readable,
      servers: (agent === null ? undefined : servers.value[agent]) ?? [],
      isOff: offKey,
    }),
    skills: skillsItem({
      tools: readable,
      skills: (agent === null ? undefined : skills.value[agent]) ?? [],
      isOff: offKey,
    }),
    repos: reposItem({
      tools: readable,
      repos: repos.value,
      isOff: offKey,
    }),
  };
}
