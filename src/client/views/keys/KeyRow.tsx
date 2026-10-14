// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An access key's row, the feed's two lines: a key, its name and scope,
// then its projects, last use and expiry. Revoke is in its More menu and
// asks first. Connect agents' list and an admin's user page draw it; it
// lives apart from both views so neither pulls in the other's stylesheet.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { AccessKey } from "../../../shared/contracts/access-key.ts";
import { Icon } from "../../lib/icons.tsx";
import { noticeOf, useSave } from "../../lib/save.ts";
import { AskDelete } from "../../ui/Foot.tsx";
import { RowsBad, RowsEnd, RowsLine, RowsTitle } from "../../ui/Rows.tsx";
import { MoreMenu } from "../knowledge/file/DocMenus.tsx";
import {
  askFocus,
  expired,
  expiresSoon,
  expiryWords,
  reachWords,
  revokeAsk,
  usedWords,
} from "./Keys.model.ts";
import "./keys.css";

export function KeyRow({
  row,
  projects,
  now,
  asking: asked = false,
  onRevoke,
}: {
  row: AccessKey;
  // the projects the viewer sees, to name the key's picks
  projects: readonly { id: string; name: string }[];
  now: number;
  // whether it opens asking
  asking?: boolean;
  onRevoke: () => Promise<void>;
}) {
  const save = useSave(async () => {});
  const asking = useSignal(asked);
  const notice = save.notice();
  const ends = expiryWords(row, now);
  // the ask swaps the More button out, so focus follows it there and back
  const acts = useRef<HTMLSpanElement>(null);
  const was = useRef(asking.value);
  useEffect(() => {
    const to = askFocus(was.current, asking.value);
    was.current = asking.value;
    const box = acts.current;
    if (to === "ask") box?.querySelector<HTMLElement>(".btn-danger")?.focus();
    if (to === "more") {
      box?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
    }
  }, [asking.value]);
  return (
    <RowsLine flush>
      <Icon name="key" size={14} class="keys-icon" />
      <RowsTitle
        name={
          <>
            <span class="cut keys-name">{row.name}</span>
            <span class="tag keys-tag">{row.scope}</span>
          </>
        }
        sub={
          // the projects give way first, so the expiry is never cut
          <span class="keys-line">
            <span class="cut">{reachWords(row, projects)}</span>
            <span class="keys-rest">
              {` · ${usedWords(row, now)} · `}
              {expired(row, now) ? (
                <RowsBad>{ends}</RowsBad>
              ) : (
                <span class={expiresSoon(row, now) ? "keys-soon" : undefined}>
                  {ends}
                </span>
              )}
            </span>
          </span>
        }
        prose
      />
      <RowsEnd
        words={asking.value && notice === null ? revokeAsk(row) : undefined}
        error={notice !== null ? noticeOf(notice) : undefined}
      >
        <span class="keys-acts" ref={acts}>
          {asking.value ? (
            <AskDelete
              save={save}
              asking={asking}
              busy={save.busy}
              small
              label="Revoke"
              action="revoke"
              going="Revoking"
              onDelete={() => void save.act("revoke", onRevoke)}
            />
          ) : (
            <MoreMenu
              label={`More for ${row.name}`}
              actions={[
                {
                  label: "Revoke",
                  icon: "trash",
                  danger: true,
                  onPick: () => {
                    save.touch();
                    asking.value = true;
                  },
                },
              ]}
            />
          )}
        </span>
      </RowsEnd>
    </RowsLine>
  );
}
