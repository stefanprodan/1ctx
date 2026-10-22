// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Config / Dictation: the switch that offers the composer's mic, the
// transcription model its clips go to, kept while the switch is off, and
// the clips of the last 30 days beside them, from the
// Monitor's overview totals as the Providers and Deciders asides read
// theirs.

import { type Signal, useSignal } from "@preact/signals";
import type { DictationResponse } from "../../../shared/api/dictation.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  dictation,
  dictationError,
  switchDictation,
} from "../../data/dictation.ts";
import { providers, providersError } from "../../data/providers.ts";
import { count, money } from "../../lib/format.ts";
import { useSave } from "../../lib/save.ts";
import { Page } from "../../ui/Page.tsx";
import { RowsSwitch } from "../../ui/Rows.tsx";
import { Setting, SettingForm, SettingStack } from "../../ui/Setting.tsx";
import { AsideLine, Split } from "../../ui/Split.tsx";
import { overviewTotals, UsageSection } from "./AdminAside.tsx";
import { audioMinutes, dictationLine, switchCheck } from "./Dictation.model.ts";
import { DictationCard } from "./DictationCard.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import { holding, useLatest } from "./drafts.ts";

export function Dictation() {
  // both answers carry the whole setting: one save at a time
  const saving = useSignal(false);
  const state = dictation.value;
  const error = dictationError.value ?? providersError.value;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Dictation"
      split
      loading={(state === null || providers.value === null) && error === null}
      error={error}
    >
      {state && providers.value && (
        <Split aside={<Aside />}>
          <SettingStack>
            <DictationSwitch state={state} saving={saving} />
            <DictationCard state={state} saving={saving} />
          </SettingStack>
        </Split>
      )}
    </Page>
  );
}

// a flip saves only on Save; the draft is null until one, so a load
// that lands after the first draw shows through
export function DictationSwitch({
  state,
  saving,
}: {
  state: DictationResponse;
  saving: Signal<boolean>;
}) {
  const drafted = useSignal<boolean | null>(null);
  const latest = useLatest(state);
  const save = useSave(() =>
    holding(saving, async () => {
      const enabled = drafted.value ?? latest.current.enabled;
      await switchDictation({ enabled });
      drafted.value = null;
    }),
  );
  const on = drafted.value ?? state.enabled;
  return (
    <SettingForm
      save={save}
      check={() =>
        switchCheck(
          drafted.value ?? latest.current.enabled,
          latest.current.settings !== null,
        )
      }
    >
      <Setting
        title="Dictation"
        line={dictationLine(on)}
        action={
          <RowsSwitch
            on={on}
            label="Dictation"
            disabled={save.busy}
            onClick={() => {
              drafted.value = !on;
              save.touch();
            }}
          />
        }
        foot={
          <DraftFoot
            save={save}
            dirty={on !== state.enabled}
            locked={saving.value}
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
      />
    </SettingForm>
  );
}

function Aside() {
  return (
    <UsageSection value={overviewTotals()}>
      {(totals) => (
        <>
          <AsideLine label="Clips">{count(totals.dictationClips)}</AsideLine>
          <AsideLine label="Audio">
            {audioMinutes(totals.dictationSeconds)}
          </AsideLine>
          <AsideLine label="Cost">
            {totals.dictationCost === null
              ? "not priced"
              : money(totals.dictationCost)}
          </AsideLine>
        </>
      )}
    </UsageSection>
  );
}
