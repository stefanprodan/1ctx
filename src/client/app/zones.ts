// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
    href: "/admin/monitor",
    icon: "visual",
    pages: [
      { label: "Usage", href: "/admin/monitor/usage" },
      { label: "Storage", href: "/admin/monitor/storage" },
    ],
  },
  {
    label: "Access",
    href: "/admin/access",
    icon: "users",
    pages: [
      { label: "Users", href: "/admin/access/users" },
      { label: "Projects", href: "/admin/access/projects" },
    ],
  },
  {
    label: "Config",
    href: "/admin/config",
    icon: "config",
    pages: [
      { label: "Providers", href: "/admin/config/providers" },
      { label: "Agents", href: "/admin/config/agents" },
      {
        label: "Deciders",
        href: "/admin/config/deciders",
        also: ["/admin/config/decisions"],
      },
      { label: "MCP Servers", href: "/admin/config/mcp" },
      { label: "Skills", href: "/admin/config/skills" },
      { label: "Visuals", href: "/admin/config/visuals" },
      { label: "Web access", href: "/admin/config/web" },
    ],
  },
];

export function zoneStep(label: "Monitor" | "Access" | "Config") {
  const zone = ZONES.find((z) => z.label === label)!;
  return { label: zone.label, href: zone.href };
}
