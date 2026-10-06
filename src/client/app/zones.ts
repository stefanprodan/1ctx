// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  ACCESS_HREF,
  AGENTS_HREF,
  CONFIG_HREF,
  DECIDERS_HREF,
  DECISIONS_HREF,
  MAIL_HREF,
  MCP_HREF,
  MONITOR_HREF,
  PROJECTS_HREF,
  PROVIDERS_HREF,
  SKILLS_HREF,
  STORAGE_HREF,
  USAGE_HREF,
  USERS_HREF,
  VISUALS_HREF,
  WEB_HREF,
} from "../lib/hrefs.ts";
import type { IconName } from "../lib/icons.tsx";

// `also`: a tab of the page at an address of its own
type ZonePage = { label: string; href: string; also?: string[] };
export type Zone = {
  label: string;
  href: string;
  icon: IconName;
  pages: ZonePage[];
};

export const ZONES: Zone[] = [
  {
    label: "Monitor",
    href: MONITOR_HREF,
    icon: "visual",
    pages: [
      { label: "Usage", href: USAGE_HREF },
      { label: "Storage", href: STORAGE_HREF },
    ],
  },
  {
    label: "Access",
    href: ACCESS_HREF,
    icon: "users",
    pages: [
      { label: "Users", href: USERS_HREF },
      { label: "Projects", href: PROJECTS_HREF },
    ],
  },
  {
    label: "Config",
    href: CONFIG_HREF,
    icon: "config",
    pages: [
      { label: "Providers", href: PROVIDERS_HREF },
      { label: "Agents", href: AGENTS_HREF },
      {
        label: "Deciders",
        href: DECIDERS_HREF,
        also: [DECISIONS_HREF],
      },
      { label: "MCP Servers", href: MCP_HREF },
      { label: "Skills", href: SKILLS_HREF },
      { label: "Visuals", href: VISUALS_HREF },
      { label: "Web access", href: WEB_HREF },
      { label: "Mail", href: MAIL_HREF },
    ],
  },
];

export function zoneStep(label: "Monitor" | "Access" | "Config") {
  const zone = ZONES.find((z) => z.label === label)!;
  return { label: zone.label, href: zone.href };
}
