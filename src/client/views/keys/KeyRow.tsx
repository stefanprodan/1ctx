// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An access key's row with Revoke, which asks first: Connect agents' list
// and an admin's user page draw it. It lives apart from both views so
// neither pulls in the other's stylesheet; it draws only Rows and Foot
// primitives, so it has none of its own.

import { useSignal } from "@preact/signals";
import type { AccessKey } from "../../../shared/contracts/access-key.ts";
import { noticeOf, useSave } from "../../lib/save.ts";
import { AskDelete } from "../../ui/Foot.tsx";
import { RowsEnd, RowsLine, RowsTitle } from "../../ui/Rows.tsx";
import { REVOKE_ASK } from "./Keys.model.ts";

export function KeyRow({
  row,
  sub,
  lines,
  asking: asked = false,
  onRevoke,
}: {
  row: AccessKey;
  sub: string;
  lines: { text: string; bad?: boolean }[];
  // whether it opens asking
  asking?: boolean;
  onRevoke: () => Promise<void>;
}) {
  const save = useSave(async () => {});
  const asking = useSignal(asked);
  const notice = save.notice();
  return (
    <RowsLine flush>
      <RowsTitle name={row.name} mono wrap sub={sub} lines={lines} />
      <RowsEnd
        words={asking.value && notice === null ? REVOKE_ASK : undefined}
        error={notice !== null ? noticeOf(notice) : undefined}
      >
        <AskDelete
          save={save}
          asking={asking}
          busy={save.busy}
          small
          ask="Revoke"
          label="Revoke"
          action="revoke"
          going="Revoking"
          onDelete={() => void save.act("revoke", onRevoke)}
        />
      </RowsEnd>
    </RowsLine>
  );
}
