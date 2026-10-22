// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Dictation page's Model card: the transcription model the
// composer's mic sends clips to, picked as a decider's model is, on a
// provider whose wire transcribes. Save keeps the model whether the
// switch above is on or off.

import type { Signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { DictationResponse } from "../../../shared/api/dictation.ts";
import { dictation, saveDictation } from "../../data/dictation.ts";
import { providers, searchCatalog } from "../../data/providers.ts";
import { PROVIDERS_HREF } from "../../lib/hrefs.ts";
import { at, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { CatalogSearch } from "./Agents.state.ts";
import { heldProvider } from "./Deciders.model.ts";
import {
  dictationFieldOf,
  dictationMeta,
  modelLine,
  transcriptionProviders,
} from "./Dictation.model.ts";
import { DictationDrafts } from "./Dictation.state.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { holding } from "./drafts.ts";
import { ModelPicker } from "./ModelPicker.tsx";

const offeredNow = () => byName(transcriptionProviders(providers.value ?? []));

export function DictationCard({
  state,
  saving,
}: {
  state: DictationResponse;
  // the page's: the switch and this card never save at once
  saving: Signal<boolean>;
}) {
  const settings = state.settings;
  const offered = offeredNow();
  const drafts = useRef<DictationDrafts | null>(null);
  if (drafts.current === null) {
    drafts.current = DictationDrafts.of(settings, offered[0]?.id ?? "");
  }
  const d = drafts.current;
  const seen = useRef(settings);
  if (seen.current !== settings) {
    d.follow(seen.current, settings, offered[0]?.id ?? "");
    seen.current = settings;
  }
  // a provider deleted, or the first one added, while Dictation is off
  const providerId = heldProvider(offered, d.providerId.value);
  const search = useRef<CatalogSearch | null>(null);
  if (search.current === null) {
    search.current = new CatalogSearch((q) =>
      searchCatalog(
        heldProvider(offeredNow(), d.providerId.value),
        q,
        "transcription",
      ),
    );
  }
  useEffect(() => () => search.current?.dispose(), []);
  const reset = () =>
    d.reset(dictation.value?.settings ?? null, offeredNow()[0]?.id ?? "");
  const save = useSave(async () => {
    const model = d.model.value;
    if (model === null) return;
    await holding(saving, () =>
      saveDictation({
        providerId: heldProvider(offeredNow(), d.providerId.value),
        model: model.id,
      }),
    );
    const meta = model.meta;
    reset();
    // the saved row names no price; the pick just made did
    if (d.model.value?.id === model.id) d.model.value = { id: model.id, meta };
  }, dictationFieldOf);
  if (offered.length === 0 && settings === null) {
    return (
      <Setting
        title="Model"
        line={
          <>
            No provider can transcribe. Add an OpenRouter or OpenAI-compatible
            one in <a href={PROVIDERS_HREF}>Providers</a>.
          </>
        }
      />
    );
  }
  const model = d.model.value;
  return (
    <SettingForm
      save={save}
      check={() => at("model", d.model.value === null ? "Pick a model" : null)}
    >
      <Setting
        title="Model"
        line={modelLine(settings !== null)}
        foot={
          <DraftFoot
            save={save}
            dirty={d.dirty(settings)}
            blocked={model === null || d.changing.value}
            open={settings !== null && d.changing.value}
            locked={saving.value}
            onDiscard={reset}
          />
        }
      >
        <ModelPicker
          save={save}
          search={search.current}
          providers={offered}
          providerId={providerId}
          model={model}
          changing={d.changing.value}
          cancellable={d.cancellable}
          currentId={settings?.model ?? null}
          matchMeta={dictationMeta}
          autofocus={false}
          onChange={() => d.change()}
          onCancel={() => d.cancel()}
          onProvider={(id) => d.chooseProvider(id)}
          onPick={(m) => d.pick(m)}
        />
      </Setting>
    </SettingForm>
  );
}
