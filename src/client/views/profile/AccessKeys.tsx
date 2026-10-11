// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The profile's Access keys section: the user's keys with Revoke, New
// access key opening its form in the list, and after a create the key
// with its setup lines, shown once. The key lives in this view alone,
// so it is gone once the user presses Done or leaves the page.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { CreateAccessKeyResponse } from "../../../shared/api/profile.ts";
import type { AccessKey } from "../../../shared/contracts/access-key.ts";
import type { Profile } from "../../../shared/contracts/user.ts";
import {
  accessKeys,
  accessKeysError,
  accessKeysLimit,
  createAccessKey,
  revokeAccessKey,
} from "../../data/access-keys.ts";
import { projects } from "../../data/projects.ts";
import { copyText } from "../../lib/clipboard.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import {
  type Save,
  useArrivalFocus,
  useFocusField,
  useSave,
} from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Labelled } from "../../ui/Labelled.tsx";
import {
  RowsAdd,
  RowsFailed,
  RowsList,
  RowsNew,
  RowsNote,
} from "../../ui/Rows.tsx";
import { Section } from "../../ui/Section.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { TextField } from "../admin/CredentialFields.tsx";
import { AddProject, ProjectRows } from "../admin/ProjectPicks.tsx";
import { KeyRow } from "../keys/KeyRow.tsx";
import {
  createdWords,
  expired,
  expiryWords,
  reachWords,
  scopeWords,
  usedWords,
} from "../keys/Keys.model.ts";
import {
  CODEX_ENV,
  capLine,
  claudeLine,
  codexBlock,
  createBody,
  DAYS_OPTIONS,
  type KeyDraft,
  keyFieldOf,
  keyProblem,
  MUST_CHANGE_TEXT,
  NEW_KEY,
  OFF_TEXT,
  REACH_OPTIONS,
  reachHint,
  SCOPE_OPTIONS,
  SECTION_TEXT,
  SHOWN_ONCE,
  scopeHint,
} from "./AccessKeys.model.ts";
import "./profile.css";

export function AccessKeys({ user }: { user: Profile }) {
  const keys = accessKeys.value;
  const limit = accessKeysLimit.value;
  const failed = accessKeysError.value;
  const open = useSignal(false);
  const shown = useSignal<CreateAccessKeyResponse | null>(null);
  const now = useNow(60_000);
  const off = keys !== null && limit === 0;
  const locked = user.mustChangePassword;
  const full = keys !== null && !off && keys.length >= limit;
  const add = keys !== null && !off && !locked && !full;
  const list = projects.value ?? [];
  return (
    <Section
      title="Access keys"
      text={off ? OFF_TEXT : locked ? MUST_CHANGE_TEXT : SECTION_TEXT}
    >
      <div class="field">
        {add && (
          <div class="profile-keys-head">
            <RowsAdd
              label="New access key"
              disabled={open.value || shown.value !== null}
              onClick={() => {
                open.value = true;
              }}
            />
          </div>
        )}
        {(failed !== null ||
          (keys !== null && !(off && keys.length === 0))) && (
          <RowsList>
            {failed !== null && <RowsFailed failure={failed} />}
            {open.value && add && keys !== null && (
              <RowsNew>
                <KeyForm
                  keys={keys}
                  username={user.username}
                  onClose={() => {
                    open.value = false;
                  }}
                  onMade={(made) => {
                    open.value = false;
                    shown.value = made;
                  }}
                />
              </RowsNew>
            )}
            {shown.value !== null && (
              <RowsNew>
                <ShownKey
                  token={shown.value.token}
                  origin={globalThis.location?.origin ?? ""}
                  onDone={() => {
                    shown.value = null;
                  }}
                />
              </RowsNew>
            )}
            {keys !== null && keys.length === 0 && !open.value && (
              <RowsNote>No access keys yet.</RowsNote>
            )}
            {keys?.map((key) => (
              <KeyRow
                key={key.id}
                row={key}
                sub={`${scopeWords(key.scope)} · ${reachWords(key, list)}`}
                lines={[
                  { text: `${createdWords(key)} · ${usedWords(key, now)}` },
                  { text: expiryWords(key, now), bad: expired(key, now) },
                ]}
                onRevoke={() => revokeAccessKey(key.id)}
              />
            ))}
          </RowsList>
        )}
        {full && <span class="hint">{capLine(limit)}</span>}
      </div>
    </Section>
  );
}

export function KeyForm({
  keys,
  username,
  onClose,
  onMade,
}: {
  keys: readonly AccessKey[];
  username: string;
  onClose: () => void;
  onMade: (made: CreateAccessKeyResponse) => void;
}) {
  const draft = useSignal<KeyDraft>(NEW_KEY);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    onMade(await createAccessKey(createBody(draft.value)));
  }, keyFieldOf);
  useFocusField(save, form);
  useArrivalFocus(form, "name");
  const d = draft.value;
  const set = (patch: Partial<KeyDraft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  return (
    <form
      ref={form}
      class="profile-key-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(keyProblem(draft.value, keys));
      }}
    >
      <KeyFields draft={d} save={save} username={username} set={set} />
      <Foot
        save={save}
        dirty={d.name.trim() !== ""}
        label="Create access key"
        before={
          <button
            type="button"
            class="btn"
            disabled={save.busy}
            onClick={onClose}
          >
            Cancel
          </button>
        }
      />
    </form>
  );
}

// the form's fields, each showing a refusal that names it in its hint's
// place
export function KeyFields({
  draft: d,
  save,
  username,
  set,
}: {
  draft: KeyDraft;
  save: Save;
  username: string;
  set: (patch: Partial<KeyDraft>) => void;
}) {
  const visible = projects.value ?? [];
  return (
    <>
      <TextField
        label="Name"
        name="name"
        value={d.name}
        placeholder="laptop-claude"
        hint={`History names its writes @${username} via this name.`}
        required
        save={save}
        onInput={(name) => set({ name })}
      />
      <Labelled
        label="Access"
        field="scope"
        save={save}
        hint={scopeHint(d.scope)}
      >
        <Seg
          label="Access"
          name="scope"
          value={d.scope}
          options={SCOPE_OPTIONS.map((o) => ({ ...o, disabled: save.busy }))}
          onPick={(scope) => set({ scope })}
        />
      </Labelled>
      <Labelled
        label="Projects"
        field="projectIds"
        save={save}
        hint={reachHint(d.reach)}
      >
        <Seg
          label="Projects"
          name="projectIds"
          value={d.reach}
          invalid={save.fieldError("projectIds") !== null}
          options={REACH_OPTIONS.map((o) => ({ ...o, disabled: save.busy }))}
          onPick={(reach) => set({ reach })}
        />
        {d.reach === "picked" && (
          <div class="profile-key-picks">
            {d.projectIds.length > 0 && (
              <RowsList>
                <ProjectRows
                  teams={visible}
                  value={d.projectIds}
                  save={save}
                  onChange={(projectIds) => set({ projectIds })}
                />
              </RowsList>
            )}
            <div class="profile-key-add">
              <AddProject
                teams={visible}
                value={d.projectIds}
                disabled={save.busy}
                empty="Every project is picked"
                onChange={(projectIds) => set({ projectIds })}
              />
            </div>
          </div>
        )}
      </Labelled>
      <Labelled label="Expires after" field="days" save={save} required>
        <Seg
          label="Expires after"
          name="days"
          value={String(d.days)}
          options={DAYS_OPTIONS.map((o) => ({
            value: String(o.value),
            label: o.label,
            disabled: save.busy,
          }))}
          onPick={(days) => {
            const picked = DAYS_OPTIONS.find((o) => String(o.value) === days);
            if (picked !== undefined) set({ days: picked.value });
          }}
        />
      </Labelled>
    </>
  );
}

// the key once, and the two ways to hand it to an agent
export function ShownKey({
  token,
  origin,
  onDone,
}: {
  token: string;
  origin: string;
  onDone: () => void;
}) {
  return (
    <div class="profile-key-shown">
      <p class="profile-key-once" role="status">
        {SHOWN_ONCE}
      </p>
      <Snippet label="Key" text={token} />
      <Snippet label="Claude Code" text={claudeLine(origin, token)} />
      <Snippet
        label="Codex"
        text={codexBlock(origin)}
        hint={`In ~/.codex/config.toml. Set ${CODEX_ENV} to the key.`}
      />
      <div class="profile-key-done">
        <button type="button" class="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function Snippet({
  label,
  text,
  hint,
}: {
  label: string;
  text: string;
  hint?: string;
}) {
  const copied: Signal<boolean> = useSignal(false);
  useEffect(() => {
    if (!copied.value) return;
    const timer = setTimeout(() => {
      copied.value = false;
    }, 1200);
    return () => clearTimeout(timer);
  }, [copied.value]);
  return (
    <div class="field">
      <span class="label">{label}</span>
      <div class="profile-key-snippet">
        <pre class="textbox profile-key-text">{text}</pre>
        <button
          type="button"
          class="btn-icon profile-key-copy"
          title={copied.value ? "Copied" : "Copy"}
          aria-label={`Copy ${label}`}
          onClick={() => {
            void copyText(text).then((ok) => {
              copied.value = ok;
            });
          }}
        >
          <Icon name={copied.value ? "check" : "copy"} size={14} />
        </button>
      </div>
      {hint !== undefined && <span class="hint">{hint}</span>}
    </div>
  );
}
