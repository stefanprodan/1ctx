// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Config / Sandbox: which shell runs the bash tool's commands, the
// OpenShell gateway, image variant or custom image of the sandbox one,
// where its commands may connect, and the sandboxes the instance holds
// (SandboxLeases.tsx). The gateway's key files are shown by name only,
// never their values.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { SandboxResponse } from "../../../shared/api/sandbox.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  sandbox,
  sandboxError,
  sandboxLeases,
  sandboxLeasesError,
  sandboxRefused,
  saveSandbox,
  watchSandboxLeases,
} from "../../data/sandbox.ts";
import {
  BACKEND_OPTIONS,
  VARIANT_OPTIONS,
  variantLine,
} from "../../lib/backends.ts";
import { count } from "../../lib/format.ts";
import { browserTab, type PollDriver } from "../../lib/poll.ts";
import { at, type Save, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Page } from "../../ui/Page.tsx";
import { Seg } from "../../ui/Seg.tsx";
import {
  Setting,
  SettingAlert,
  SettingForm,
  SettingStack,
} from "../../ui/Setting.tsx";
import { AsideItem, AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { CardsWaiting } from "./AdminWaiting.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import "./sandbox.css";
import { useLatest } from "./drafts.ts";
import {
  backendLine,
  draftOf,
  gatewayShown,
  HOSTS_HINT,
  keyFiles,
  leaseCounts,
  missingKeys,
  NET_DEFAULTS,
  NETWORK_LINE,
  NETWORK_OPTIONS,
  type NetDraft,
  netAtDefaults,
  netBody,
  netCount,
  netDirty,
  netDraftOf,
  netFieldOf,
  netRows,
  offLine,
  overridesLine,
  refusedLine,
  type SandboxDraft,
  type SandboxField,
  sandboxBody,
  sandboxDirty,
  sandboxFieldOf,
  sandboxOn,
} from "./Sandbox.model.ts";
import { Leases } from "./SandboxLeases.tsx";

export function Sandbox() {
  return <SandboxView tab={browserTab} />;
}

// tab: what the list's poll watches, a fake in a test
export function SandboxView({ tab }: { tab: PollDriver }) {
  const state = sandbox.value;
  const error = sandboxError.value;
  const drafted = useSignal<SandboxDraft | null>(null);
  useEffect(() => watchSandboxLeases(tab), [tab]);
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Sandbox"
      split
      loading={state === null && error === null}
      waiting={
        <CardsWaiting
          label="Loading the sandbox shell"
          cards={[
            {
              title: "Shell",
              line: true,
              fields: ["seg-row", "wide", "wide"],
              foot: 2,
            },
            { title: "Sandboxes", line: true, rows: 0 },
          ]}
        />
      }
      error={error}
    >
      {state && (
        <Split aside={<Aside state={state} />}>
          <SandboxCards state={state} drafted={drafted} />
        </Split>
      )}
    </Page>
  );
}

export function SandboxCards({
  state,
  drafted,
}: {
  state: SandboxResponse;
  drafted: Signal<SandboxDraft | null>;
}) {
  const off = offLine(state);
  const refused = sandboxRefused.value;
  const backend = (drafted.value ?? draftOf(state.settings)).backend;
  return (
    <SettingStack>
      {off !== null && <SettingAlert>{off}</SettingAlert>}
      {refused !== null && <SettingAlert>{refusedLine(refused)}</SettingAlert>}
      <Shell state={state} drafted={drafted} />
      {/* the built-in shell has no network of its own, as it has no
          gateway or image, unless a project runs openshell over it */}
      {gatewayShown(backend, state.overrides) && <Network state={state} />}
      <Leases
        rows={sandboxLeases.value}
        failed={sandboxLeasesError.value !== null}
        on={sandboxOn(state)}
      />
    </SettingStack>
  );
}

function Text({
  label,
  field,
  draft,
  save,
  placeholder,
  hint,
  onInput,
}: {
  label: string;
  field: SandboxField;
  draft: SandboxDraft;
  save: Save;
  placeholder: string;
  hint: string;
  onInput: (value: string) => void;
}) {
  const invalid = save.fieldError(field) !== null;
  return (
    <label class="field pair-wide">
      <span class="label">{label}</span>
      <input
        name={field}
        type="text"
        aria-invalid={invalid || undefined}
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
      {invalid ? (
        <FieldError save={save} field={field} />
      ) : (
        <span class="hint">{hint}</span>
      )}
    </label>
  );
}

// null until an edit, so a load that lands late shows through
function Shell({
  state,
  drafted,
}: {
  state: SandboxResponse;
  drafted: Signal<SandboxDraft | null>;
}) {
  const latest = useLatest(state);
  const save = useSave(async () => {
    const got = sandboxBody(drafted.value ?? draftOf(latest.current.settings));
    if (!("body" in got)) return;
    await saveSandbox(got.body);
    drafted.value = null;
  }, sandboxFieldOf);
  const d = drafted.value ?? draftOf(state.settings);
  const set = (patch: Partial<SandboxDraft>) => {
    drafted.value = { ...d, ...patch };
    save.touch();
  };
  const gateway = gatewayShown(d.backend, state.overrides);
  const overrides = overridesLine(state.overrides);
  return (
    <SettingForm
      save={save}
      check={() => {
        const got = sandboxBody(d);
        return "body" in got ? null : at(got.field, got.error);
      }}
    >
      <Setting
        title="Shell"
        line={
          overrides === null
            ? backendLine(d.backend)
            : `${backendLine(d.backend)} ${overrides}`
        }
        foot={
          <DraftFoot
            save={save}
            dirty={sandboxDirty(d, state.settings)}
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
      >
        <div class="pair">
          <div class="field pair-wide">
            <span class="label">Shell</span>
            <Seg
              label="Shell"
              name="backend"
              value={d.backend}
              invalid={save.fieldError("backend") !== null}
              options={BACKEND_OPTIONS.map((o) => ({
                ...o,
                disabled: save.busy,
              }))}
              // the built-in shell hides the gateway and image, so they
              // go back to their saved values rather than fail unseen,
              // unless a project's openshell keeps them shown
              onPick={(backend) =>
                set(
                  gatewayShown(backend, state.overrides)
                    ? { backend }
                    : { ...draftOf(state.settings), backend },
                )
              }
            />
            <FieldError save={save} field="backend" />
          </div>
          {gateway && (
            <>
              <Text
                label="Gateway"
                field="endpoint"
                draft={d}
                save={save}
                placeholder="https://127.0.0.1:17671"
                hint="The OpenShell gateway's https address."
                onInput={(endpoint) => set({ endpoint })}
              />
              <div class="field pair-wide">
                <span class="label">Variant</span>
                <Seg
                  label="Variant"
                  name="variant"
                  value={d.variant}
                  invalid={save.fieldError("variant") !== null}
                  options={VARIANT_OPTIONS.map((o) => ({
                    ...o,
                    disabled: save.busy,
                  }))}
                  onPick={(variant) => set({ variant })}
                />
                {save.fieldError("variant") !== null ? (
                  <FieldError save={save} field="variant" />
                ) : (
                  <span class="hint">{variantLine(d.variant)}</span>
                )}
              </div>
              <Text
                label="Image"
                field="image"
                draft={d}
                save={save}
                placeholder={state.defaultImages[d.variant]}
                hint="Empty runs the variant's image. A custom image replaces the variant."
                onInput={(image) => set({ image })}
              />
            </>
          )}
        </div>
      </Setting>
    </SettingForm>
  );
}

// null until an edit, so a load that lands late shows through
function Network({ state }: { state: SandboxResponse }) {
  const drafted = useSignal<NetDraft | null>(null);
  const latest = useLatest(state);
  const save = useSave(async () => {
    const got = netBody(drafted.value ?? netDraftOf(latest.current.settings));
    if (!("body" in got)) return;
    await saveSandbox(got.body);
    drafted.value = null;
  }, netFieldOf);
  const d = drafted.value ?? netDraftOf(state.settings);
  const set = (next: NetDraft) => {
    drafted.value = next;
    save.touch();
  };
  const invalid = save.fieldError("hosts") !== null;
  return (
    <SettingForm
      save={save}
      check={() => {
        const got = netBody(d);
        return "body" in got ? null : at("hosts", got.error);
      }}
    >
      <Setting
        title="Network"
        count={d.mode === "hosts" ? netCount(d.text) : undefined}
        line={NETWORK_LINE}
        action={
          <button
            type="button"
            class="btn btn-small"
            disabled={save.busy || netAtDefaults(d)}
            onClick={() => set(NET_DEFAULTS)}
          >
            Use defaults
          </button>
        }
        foot={
          <DraftFoot
            save={save}
            dirty={netDirty(d, state.settings)}
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
      >
        <div class="pair">
          <div class="field pair-wide">
            <span class="label">Network</span>
            <Seg
              label="Network"
              name="network"
              value={d.mode}
              options={NETWORK_OPTIONS.map((o) => ({
                ...o,
                disabled: save.busy,
              }))}
              onPick={(mode) => set({ ...d, mode })}
            />
          </div>
          {d.mode === "hosts" && (
            <label class="field pair-wide">
              <span class="label">Hosts</span>
              <textarea
                name="hosts"
                class="sandbox-hosts"
                rows={netRows(d.text)}
                spellcheck={false}
                autocomplete="off"
                value={d.text}
                disabled={save.busy}
                aria-invalid={invalid || undefined}
                onInput={(event) =>
                  set({
                    ...d,
                    text: (event.currentTarget as HTMLTextAreaElement).value,
                  })
                }
              />
              {invalid ? (
                <FieldError save={save} field="hosts" />
              ) : (
                <span class="hint">{HOSTS_HINT}</span>
              )}
            </label>
          )}
        </div>
      </Setting>
    </SettingForm>
  );
}

function Aside({ state }: { state: SandboxResponse }) {
  const rows = sandboxLeases.value;
  const counts = rows === null ? null : leaseCounts(rows);
  const missing = missingKeys(state);
  return (
    <>
      {counts !== null && (
        <AsideSection label="Sandboxes">
          <AsideLine label="In use">{count(counts.inUse)}</AsideLine>
          <AsideLine label="Warm">{count(counts.warm)}</AsideLine>
          <AsideLine label="Stuck">{count(counts.stuck)}</AsideLine>
        </AsideSection>
      )}
      <AsideSection label="Gateway">
        <AsideLine label="Label" cut>
          {state.gatewayLabel}
        </AsideLine>
      </AsideSection>
      <AsideSection label="Key files">
        {keyFiles().map((file) => (
          <AsideItem key={file} name={file} quiet={!missing.includes(file)}>
            {missing.includes(file) ? "missing" : "found"}
          </AsideItem>
        ))}
      </AsideSection>
    </>
  );
}
