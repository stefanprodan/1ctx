// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import type { SmtpResponse } from "../../../shared/api/smtp.ts";
import { zoneStep } from "../../app/zones.ts";
import { saveSmtp, sendTestEmail, smtp, smtpError } from "../../data/smtp.ts";
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

export function Smtp() {
  const state = smtp.value;
  const error = smtpError.value;
  const off = state === null ? null : offLine(state);
  // held here, so Send test email knows the form has unsaved edits
  const drafted = useSignal<SmtpDraft | null>(null);
  const dirty =
    state !== null &&
    drafted.value !== null &&
    smtpDirty(drafted.value, state.settings);
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="SMTP"
      loading={state === null && error === null}
      error={error}
    >
      {state && (
        <SettingStack>
          {off !== null && <SettingAlert>{off}</SettingAlert>}
          <Server state={state} drafted={drafted} />
          {/* a save starts it over, so an old result never stays */}
          <Test
            key={state.settings?.updatedAt ?? 0}
            state={state}
            dirty={dirty}
          />
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
}: {
  state: SmtpResponse;
  drafted: Signal<SmtpDraft | null>;
}) {
  const latest = useLatest(state);
  const save = useSave(async () => {
    const got = smtpBody(drafted.value ?? draftOf(latest.current.settings));
    if (!("body" in got)) return;
    await saveSmtp(got.body);
    drafted.value = null;
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
function Test({ state, dirty }: { state: SmtpResponse; dirty: boolean }) {
  const send = useAction();
  const result = useSignal<string | null>(null);
  const failed = useSignal(false);
  return (
    <Setting
      title="Send test email"
      line={testLine(state, dirty)}
      action={
        <button
          type="button"
          class="btn btn-small"
          disabled={
            send.busy.value || dirty || !state.enabled || state.to === null
          }
          onClick={() =>
            void send.run(async () => {
              result.value = null;
              const got = await sendTestEmail();
              failed.value = got !== "sent";
              result.value = resultLine(got, state.to);
            })
          }
        >
          {send.busy.value ? "Sending" : "Send test email"}
        </button>
      }
    >
      {(result.value !== null || send.failure.value !== null) && (
        <p
          class={`smtp-result${
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
