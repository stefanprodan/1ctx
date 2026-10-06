// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import type { SmtpResponse } from "../../../shared/api/smtp.ts";
import { zoneStep } from "../../app/zones.ts";
import { saveSmtp, sendTestEmail, smtp, smtpError } from "../../data/smtp.ts";
import { says } from "../../lib/format.ts";
import { at, type Save, useSave } from "../../lib/save.ts";
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
  offLine,
  resultLine,
  SECURITY_OPTIONS,
  type SmtpDraft,
  type SmtpField,
  smtpBody,
  smtpDirty,
  smtpFieldOf,
  testLine,
  withSecurity,
} from "./Smtp.model.ts";
import "./smtp.css";

// Send test email's last result; a null line while it is out. Each
// test is its own object, so a save that clears it drops its answer too
export type Tested = { line: string | null; failed: boolean } | null;

export function Smtp() {
  const state = smtp.value;
  const error = smtpError.value;
  const drafted = useSignal<SmtpDraft | null>(null);
  const tested = useSignal<Tested>(null);
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="SMTP"
      loading={state === null && error === null}
      error={error}
    >
      {state && <SmtpCards state={state} drafted={drafted} tested={tested} />}
    </Page>
  );
}

// the draft and the test are held above the cards, so Send test email
// knows the form has unsaved edits and a save clears its result
export function SmtpCards({
  state,
  drafted,
  tested,
}: {
  state: SmtpResponse;
  drafted: Signal<SmtpDraft | null>;
  tested: Signal<Tested>;
}) {
  const off = offLine(state);
  const dirty =
    drafted.value !== null && smtpDirty(drafted.value, state.settings);
  return (
    <SettingStack>
      {off !== null && <SettingAlert>{off}</SettingAlert>}
      <Server state={state} drafted={drafted} tested={tested} />
      <Test state={state} dirty={dirty} tested={tested} />
    </SettingStack>
  );
}

function Text({
  label,
  field,
  draft,
  save,
  type,
  required,
  placeholder,
  onInput,
}: {
  label: string;
  field: SmtpField;
  draft: SmtpDraft;
  save: Save;
  type?: string;
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
function Server({
  state,
  drafted,
  tested,
}: {
  state: SmtpResponse;
  drafted: Signal<SmtpDraft | null>;
  tested: Signal<Tested>;
}) {
  const latest = useLatest(state);
  const save = useSave(async () => {
    const got = smtpBody(drafted.value ?? draftOf(latest.current.settings));
    if (!("body" in got)) return;
    await saveSmtp(got.body);
    drafted.value = null;
    tested.value = null;
  }, smtpFieldOf);
  const d = drafted.value ?? draftOf(state.settings);
  const set = (patch: Partial<SmtpDraft>) => {
    drafted.value = { ...d, ...patch };
  };
  const text = (
    label: string,
    field: SmtpField,
    extra: { type?: string; placeholder?: string } = {},
  ) => (
    <Text
      label={label}
      field={field}
      draft={d}
      save={save}
      required={field !== "username"}
      {...extra}
      onInput={(value) => set({ [field]: value } as Partial<SmtpDraft>)}
    />
  );
  const keyInvalid = save.fieldError("keyName") !== null;
  return (
    <SettingForm
      save={save}
      check={() => {
        const got = smtpBody(d);
        return "body" in got ? null : at(got.field, got.error);
      }}
    >
      <Setting
        title="Server"
        line="The SMTP server every email goes through."
        foot={
          <DraftFoot
            save={save}
            dirty={smtpDirty(d, state.settings)}
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
      >
        <div class="pair">
          {text("Host", "host", { placeholder: "smtp.example.com" })}
          {text("Port", "port")}
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
          {text("Username", "username")}
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
              placeholder: "https://1ctx.example.com",
            })}
          </div>
        </div>
      </Setting>
    </SettingForm>
  );
}

// it sends through the saved server, so it waits while edits are not
function Test({
  state,
  dirty,
  tested,
}: {
  state: SmtpResponse;
  dirty: boolean;
  tested: Signal<Tested>;
}) {
  const shown = tested.value;
  const sending = shown !== null && shown.line === null;
  const run = async () => {
    const mine: Tested = { line: null, failed: false };
    tested.value = mine;
    let line: string;
    let failed: boolean;
    try {
      const got = await sendTestEmail();
      line = resultLine(got, state.to);
      failed = got !== "sent";
    } catch (err) {
      line = says(err);
      failed = true;
    }
    if (tested.value === mine) tested.value = { line, failed };
  };
  return (
    <Setting
      title="Send test email"
      line={testLine(state, dirty)}
      action={
        <button
          type="button"
          class="btn btn-small"
          disabled={sending || dirty || !state.enabled || state.to === null}
          onClick={() => void run()}
        >
          {sending ? "Sending" : "Send test email"}
        </button>
      }
    >
      {shown !== null && shown.line !== null && (
        <p class={`smtp-result${shown.failed ? " error" : ""}`} role="status">
          {shown.line}
        </p>
      )}
    </Setting>
  );
}
