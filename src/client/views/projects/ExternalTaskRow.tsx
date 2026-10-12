// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An external task as a row leading to its page: its state's icon, the
// title and its scope, who holds the claim, the latest entry cut to a
// line, and when it last moved. Home's section names its project too.

import type { ExternalTaskRow } from "../../../shared/contracts/external-task.ts";
import { ago } from "../../lib/format.ts";
import { externalTaskHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import {
  RowsAvatar,
  RowsGo,
  RowsMeta,
  RowsTag,
  RowsTitle,
} from "../../ui/Rows.tsx";
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
  const sub = [project == null ? "" : `#${project}`, rowLine(row)]
    .filter((part) => part !== "")
    .join(" · ");
  const last = lastLine(row);
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
        name={
          <>
            <span class="cut">{row.title}</span>
            {row.scope !== null && (
              <>
                {" "}
                <RowsTag>{row.scope}</RowsTag>
              </>
            )}
          </>
        }
        sub={sub === "" ? undefined : sub}
        lines={last === null ? undefined : [{ text: last }]}
      />
      <RowsMeta>{ago(row.movedAt, now)}</RowsMeta>
    </RowsGo>
  );
}
