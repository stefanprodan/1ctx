// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task as a row leading to its page: its state's icon, the
// title, then its scope, who holds the claim and the latest entry, each
// cut to a line, and when it last moved. Home's section names its
// project too.

import type { ExternalTaskRow } from "../../../shared/contracts/external-task.ts";
import { ago } from "../../lib/format.ts";
import { externalTaskHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { RowsAvatar, RowsGo, RowsMeta, RowsTitle } from "../../ui/Rows.tsx";
import { lastLine, rowLine, taskIcon } from "./ExternalTasks.model.ts";

export function TaskRow({
  row,
  now,
  project,
}: {
  row: ExternalTaskRow;
  now: number;
  // the project's name, on a list across projects
  project?: string | null;
}) {
  const icon = taskIcon(row);
  const claim = [project == null ? "" : `#${project}`, rowLine(row)]
    .filter((part) => part !== "")
    .join(" · ");
  // the scope is free text as long as the title, so never beside it
  const [sub, ...lines] = [row.scope, claim, lastLine(row)]
    .filter((text) => text !== null && text !== "")
    .map((text) => ({ text }));
  return (
    <RowsGo href={externalTaskHref(row.id)}>
      <RowsAvatar>
        <Icon
          name={icon.name}
          size={15}
          class={icon.status === null ? undefined : `status-${icon.status}`}
        />
      </RowsAvatar>
      <RowsTitle
        name={row.title}
        sub={sub?.text}
        lines={lines.length === 0 ? undefined : lines}
      />
      <RowsMeta>{ago(row.movedAt, now)}</RowsMeta>
    </RowsGo>
  );
}
