// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { MailResponse } from "../../../shared/api/mail.ts";
import { zoneStep } from "../../app/zones.ts";
import { mail, mailError, saveMail, testMail } from "../../data/mail.ts";
import { at, type Save, useAction, useSave } from "../../lib/save.ts";
import { keyOptions } from "../../lib/secrets.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Page } from "../../ui/Page.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  Setting,
  SettingAlert,
  SettingForm,
  SettingStack,
} from "../../ui/Setting.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
import {
  draftOf,
  type MailDraft,
  type MailField,
  mailBody,
  mailDirty,
  mailFieldOf,
  offLine,
  resultLine,
  SECURITY_OPTIONS,
  testLine,
  withSecurity,
} from "./Mail.model.ts";
import "./mail.css";

export function Mail() {
  const state = mail.value;
  const error = mailError.value;
  const off = state === null ? null : offLine(state);
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Mail"
      loading={state === null && error === null}
      error={error}
    >
      {state && (
        <SettingStack>
          {off !== null && <SettingAlert>{off}</SettingAlert>}
          <Server state={state} />
          <Test state={state} />
        </SettingStack>
      )}
    </Page>
  );
}

function Text({
  label,
  field,
  draft,
  save,
  type,
  mono,
  required,
  placeholder,
  onInput,
}: {
  label: string;
  field: MailField;
  draft: MailDraft;
  save: Save;
  type?: string;
  mono?: boolean;
  required?: boolean;
  placeholder?: string;
  onInput: (value: string) => void;
}) {
  return (
    <label class="field">
      <span class={`label${required ? " label-required" : ""}`}>{label}</span>
      <input
        name={field}
        type={type}
        class={mono ? "mail-mono" : undefined}
        aria-required={required || undefined}
        aria-invalid={save.fieldError(field) !== null || undefined}
        autocomplete="off"
        spellcheck={false}
        placeholder={placeholder}
        disabled={save.busy}
        value={draft[field]}
        onInput={(event) => {
          onInput((event.currentTarget as HTMLInputElement).value);
          save.touch();
        }}
      />
      <FieldError save={save} field={field} />
    </label>
  );
}

// null until an edit, so a load that lands late shows through
function Server({ state }: { state: MailResponse }) {
  const drafted = useSignal<MailDraft | null>(null);
  const latest = useLatest(state);
  const save = useSave(async () => {
    const got = mailBody(drafted.value ?? draftOf(latest.current.settings));
    if (!("body" in got)) return;
    await saveMail(got.body);
    drafted.value = null;
  }, mailFieldOf);
  const d = drafted.value ?? draftOf(state.settings);
  const set = (patch: Partial<MailDraft>) => {
    drafted.value = { ...d, ...patch };
  };
  const text = (
    label: string,
    field: MailField,
    extra: { type?: string; mono?: boolean; placeholder?: string } = {},
  ) => (
    <Text
      label={label}
      field={field}
      draft={d}
      save={save}
      required={field !== "username"}
      {...extra}
      onInput={(value) => set({ [field]: value } as Partial<MailDraft>)}
    />
  );
  const keyInvalid = save.fieldError("keyName") !== null;
  return (
    <SettingForm
      save={save}
      check={() => {
        const got = mailBody(d);
        return "body" in got ? null : at(got.field, got.error);
      }}
    >
      <Setting
        title="Server"
        line="The SMTP server every mail goes through."
        foot={
          <DraftFoot
            save={save}
            dirty={mailDirty(d, state.settings)}
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
      >
        <div class="pair">
          {text("Host", "host", {
            mono: true,
            placeholder: "smtp.example.com",
          })}
          {text("Port", "port", { mono: true })}
          <div class="field pair-wide">
            <span class="label label-required">Security</span>
            <Seg
              label="Security"
              name="security"
              value={d.security}
              options={SECURITY_OPTIONS.map((o) => ({
                ...o,
                disabled: save.busy,
              }))}
              onPick={(security) => {
                drafted.value = withSecurity(d, security);
                save.touch();
              }}
            />
          </div>
          {text("Username", "username", { mono: true })}
          <div class="field">
            <span class="label">Password key file</span>
            <Select
              label="Password key file"
              name="keyName"
              mono
              value={d.keyName}
              options={keyOptions(state.keys, d.keyName)}
              disabled={save.busy}
              invalid={keyInvalid}
              onChange={(keyName) => {
                set({ keyName });
                save.touch();
              }}
            />
            {keyInvalid ? (
              <FieldError save={save} field="keyName" />
            ) : (
              <span class="hint">An email- file in the secrets folder.</span>
            )}
          </div>
          {text("From address", "fromAddress", {
            type: "email",
            placeholder: "1ctx@example.com",
          })}
          {text("From name", "fromName")}
          <div class="pair-wide">
            {text("Public address", "publicAddress", {
              mono: true,
              placeholder: "https://1ctx.example.com",
            })}
          </div>
        </div>
      </Setting>
    </SettingForm>
  );
}

function Test({ state }: { state: MailResponse }) {
  const send = useAction();
  const result = useSignal<string | null>(null);
  const failed = useSignal(false);
  return (
    <Setting
      title="Send test"
      line={testLine(state)}
      action={
        <button
          type="button"
          class="btn btn-small"
          disabled={send.busy.value || !state.enabled || state.to === null}
          onClick={() =>
            void send.run(async () => {
              result.value = null;
              const got = await testMail();
              failed.value = got !== "sent";
              result.value = resultLine(got, state.to);
            })
          }
        >
          {send.busy.value ? "Sending" : "Send test"}
        </button>
      }
    >
      {(result.value !== null || send.failure.value !== null) && (
        <p
          class={`mail-result${
            failed.value || send.failure.value !== null ? " error" : ""
          }`}
          role="status"
        >
          {send.failure.value ?? result.value}
        </p>
      )}
    </Setting>
  );
}
