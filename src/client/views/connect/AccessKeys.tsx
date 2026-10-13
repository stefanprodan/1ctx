// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Access keys card: the user's keys with Revoke, New access key
// leading to its own page, and after a create the key with the line
// that exports it, shown once. The key lives in the Connect agents view
// alone, so it is gone once the user presses Done or leaves the page.

import { type Signal, useSignal } from "@preact/signals";
import type { CreateAccessKeyResponse } from "../../../shared/api/profile.ts";
import type { AccessKey } from "../../../shared/contracts/access-key.ts";
import { navigate } from "../../app/router.ts";
import {
  accessKeys,
  accessKeysError,
  accessKeysLimit,
  createAccessKey,
  revokeAccessKey,
} from "../../data/access-keys.ts";
import { projects } from "../../data/projects.ts";
import { useNow } from "../../lib/now.ts";
import { type Save, useSave } from "../../lib/save.ts";
import { Labelled } from "../../ui/Labelled.tsx";
import {
  RowsAdd,
  RowsCard,
  RowsFailed,
  RowsList,
  RowsNew,
  RowsNote,
} from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { TextField } from "../admin/CredentialFields.tsx";
import { NewCard } from "../admin/NewCard.tsx";
import { AddProject, ProjectRows } from "../admin/ProjectPicks.tsx";
import { KeyRow } from "../keys/KeyRow.tsx";
import {
  capLine,
  createBody,
  DAYS_OPTIONS,
  exportLine,
  type KeyDraft,
  keyFieldOf,
  keyProblem,
  NEW_KEY,
  OFF_TEXT,
  REACH_OPTIONS,
  reachHint,
  SCOPE_OPTIONS,
  SHOWN_ONCE,
  scopeHint,
} from "./AccessKeys.model.ts";
import { CONNECT_HREF, NEW_KEY_HREF } from "./Setup.model.ts";
import { Snippet } from "./Snippet.tsx";
import "./connect.css";

export function AccessKeys({
  shown,
}: {
  shown: Signal<CreateAccessKeyResponse | null>;
}) {
  const keys = accessKeys.value;
  const limit = accessKeysLimit.value;
  const failed = accessKeysError.value;
  const now = useNow(60_000);
  const off = keys !== null && limit === 0;
  const full = keys !== null && !off && keys.length >= limit;
  const add = keys !== null && !off && !full;
  const list = projects.value ?? [];
  return (
    <RowsCard
      label="Access keys"
      menus
      count={keys !== null && !off ? `${keys.length} of ${limit}` : undefined}
      action={
        add ? (
          <RowsAdd
            label="New access key"
            disabled={shown.value !== null}
            onClick={() => navigate(NEW_KEY_HREF)}
          />
        ) : undefined
      }
    >
      {failed !== null && <RowsFailed failure={failed} />}
      {shown.value !== null && (
        <RowsNew>
          <ShownKey
            token={shown.value.token}
            onDone={() => {
              shown.value = null;
            }}
          />
        </RowsNew>
      )}
      {off && <RowsNote>{OFF_TEXT}</RowsNote>}
      {!off && keys !== null && keys.length === 0 && (
        <RowsNote>No access keys yet.</RowsNote>
      )}
      {keys?.map((key) => (
        <KeyRow
          key={key.id}
          row={key}
          projects={list}
          now={now}
          onRevoke={() => revokeAccessKey(key.id)}
        />
      ))}
      {full && <RowsNote>{capLine(limit)}</RowsNote>}
    </RowsCard>
  );
}

// the New access key page: one card, its fields in pairs, Create in its
// foot; a made key goes back to the list to be shown once
export function NewKeyForm({
  keys,
  username,
  onMade,
}: {
  keys: readonly AccessKey[];
  username: string;
  onMade: (made: CreateAccessKeyResponse) => void;
}) {
  const draft = useSignal<KeyDraft>(NEW_KEY);
  const save = useSave(async () => {
    onMade(await createAccessKey(createBody(draft.value)));
  }, keyFieldOf);
  const d = draft.value;
  const set = (patch: Partial<KeyDraft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  const name = d.name.trim();
  const taken = keys.some((k) => k.name === name);
  return (
    <NewCard
      label="New access key"
      create="Create access key"
      cancel={CONNECT_HREF}
      save={save}
      ready={name !== "" && (d.reach === "all" || d.projectIds.length > 0)}
      taken={taken ? name : null}
      first="name"
      onSubmit={() => {
        void save.run(keyProblem(draft.value, keys));
      }}
    >
      <KeyFields draft={d} save={save} username={username} set={set} />
    </NewCard>
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
    <div class="pair">
      <TextField
        label="Name"
        name="name"
        value={d.name}
        placeholder="claude-code"
        hint={`Edits show as @${username} via ${d.name.trim() || "this name"}.`}
        required
        shaped
        save={save}
        onInput={(name) => set({ name })}
      />
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
          <div class="connect-key-picks">
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
            <div class="connect-key-add">
              <AddProject
                teams={visible}
                value={d.projectIds}
                disabled={save.busy}
                empty="Every project is picked"
                align="left"
                onChange={(projectIds) => set({ projectIds })}
              />
            </div>
          </div>
        )}
      </Labelled>
    </div>
  );
}

// the key once, and the line that hands it to every setup below
export function ShownKey({
  token,
  onDone,
}: {
  token: string;
  onDone: () => void;
}) {
  return (
    <div class="connect-key-shown">
      <p class="connect-key-once" role="status">
        {SHOWN_ONCE}
      </p>
      <Snippet label="Key" text={token} />
      <Snippet
        label="Environment"
        text={exportLine(token)}
        hint="In your shell profile."
      />
      <div class="connect-key-done">
        <button type="button" class="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
