// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The admin face's tree: three zones, each a header that opens its
// overview, with its pages under it. The rail draws it and a zone's
// board lists it; the route table has a route for every address here,
// which the table test checks.

import type { IconName } from "../lib/icons.tsx";

// `also` are addresses the page stands for too: a tab of it at an
// address of its own
export type ZonePage = { label: string; href: string; also?: string[] };
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
      { label: "Tools", href: "/admin/config/tools" },
    ],
  },
];

// a crumb's zone step, a link to the zone's overview
export function zoneStep(label: "Monitor" | "Access" | "Config") {
  const zone = ZONES.find((z) => z.label === label)!;
  return { label: zone.label, href: zone.href };
}
