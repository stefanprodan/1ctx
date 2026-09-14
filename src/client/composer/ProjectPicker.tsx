// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chip that names the project a new chat starts in, on Home, where
// the composer is not bound to one. It opens the projects the user
// may see, in the rail's order.

import type { ProjectSummary } from "../../shared/contracts/project.ts";
import { Icon, projectIcon } from "../lib/icons.tsx";
import { useMenu } from "./menu.ts";

export function ProjectPicker({
  projects,
  projectId,
  onPick,
}: {
  projects: ProjectSummary[];
  projectId: string;
  onPick: (id: string) => void;
}) {
  const { open, root } = useMenu();
  const picked = projects.find((p) => p.id === projectId) ?? null;
  return (
    <div class="composer-agent" ref={root}>
      <button
        type="button"
        class="composer-chip"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <span class="composer-chip-tile">
          <Icon name={projectIcon(picked?.kind ?? "team")} size={12} />
        </span>
        <span class="composer-chip-name">{picked?.name ?? "no project"}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open.value && (
        <ul class="composer-menu">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                class={`composer-option${p.id === projectId ? " composer-option-on" : ""}`}
                onClick={() => {
                  open.value = false;
                  onPick(p.id);
                }}
              >
                <span class="composer-chip-tile">
                  <Icon name={projectIcon(p.kind)} size={12} />
                </span>
                <span class="composer-chip-name">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
