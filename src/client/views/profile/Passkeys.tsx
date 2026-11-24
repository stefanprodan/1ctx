// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The profile's Passkeys section: every passkey of the user with its
// provider, when it was added and last used, the host of one added at
// another address, and Remove asked once; Add a passkey under them.
// Absent where the browser has no WebAuthn.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Passkey } from "../../../shared/api/profile.ts";
import { passkeys } from "../../data/passkeys.ts";
import { Icon } from "../../lib/icons.tsx";
import { noticeOf, useSave } from "../../lib/save.ts";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import {
  RowsAvatar,
  RowsEnd,
  RowsFailed,
  RowsLine,
  RowsList,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Section, SectionForm } from "../../ui/Section.tsx";
import {
  elsewhere,
  NO_PASSKEYS,
  PASSKEYS_TEXT,
  passkeyLines,
} from "./Passkeys.model.ts";
import "./profile.css";

export function PasskeysSection() {
  if (!passkeys.support.value) return null;
  return (
    <Section title="Passkeys" text={PASSKEYS_TEXT}>
      <PasskeysForm />
    </Section>
  );
}

function PasskeysForm() {
  const p = passkeys;
  // options in hand before the tap, as iOS asks only inside it
  useEffect(() => p.prime("add"), [p]);
  const save = useSave(async () => {
    if (await p.add()) return;
    const words = p.error.peek();
    // a closed sheet says nothing
    if (words !== null) throw new Error(words);
  });
  const all = p.list.value;
  const failed = p.failed.value;
  const now = Date.now();
  return (
    <SectionForm
      onSubmit={(event: Event) => {
        event.preventDefault();
        // no await before the browser is asked: run() calls the add at once
        void save.run(null);
      }}
    >
      <div class="field">
        <RowsList>
          {failed !== null && <RowsFailed failure={failed} />}
          {all !== null && all.length === 0 && (
            <RowsNote>{NO_PASSKEYS}</RowsNote>
          )}
          {all?.map((k) => (
            <PasskeyRow
              key={k.id}
              passkey={k}
              at={elsewhere(k, p.origin())}
              now={now}
            />
          ))}
        </RowsList>
      </div>
      <Foot save={save}>
        <button
          type="submit"
          class="btn btn-primary"
          disabled={save.busy || p.busy.value || p.waiting("add")}
        >
          {p.busy.value ? "Adding" : "Add a passkey"}
        </button>
      </Foot>
    </SectionForm>
  );
}

function PasskeyRow({
  passkey,
  at,
  now,
}: {
  passkey: Passkey;
  // the other address it signs in at; null for this one
  at: string | null;
  now: number;
}) {
  const save = useSave(async () => {});
  const asking = useSignal(false);
  const notice = save.notice();
  const l = passkeyLines(passkey, now);
  // the line wraps between its parts, never inside one
  const parts = [l.added, l.used, ...(at === null ? [] : [at])];
  return (
    <RowsLine flush>
      <RowsAvatar>
        <Icon name="key" size={14} />
      </RowsAvatar>
      <RowsTitle
        name={passkey.device}
        sub={parts.map((part, i) => (
          <span key={part}>
            {i > 0 && " · "}
            <span class="profile-when">{part}</span>
          </span>
        ))}
        wrap
        prose
      />
      <RowsEnd
        words={
          asking.value && notice === null ? "Remove this passkey?" : undefined
        }
        error={notice !== null ? noticeOf(notice) : undefined}
      >
        <AskDelete
          save={save}
          asking={asking}
          busy={save.busy}
          small
          ask="Remove"
          label="Remove"
          action="remove"
          going="Removing"
          onDelete={() =>
            void save.act("remove", () => passkeys.remove(passkey.id))
          }
        />
      </RowsEnd>
    </RowsLine>
  );
}
