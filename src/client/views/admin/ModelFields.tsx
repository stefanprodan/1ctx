// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "preact/hooks";
import { fixedThinking } from "../../../shared/thinking.ts";
import { modelMeta } from "../../agents/meta.ts";
import { providers, searchCatalog } from "../../data/providers.ts";
import type { Save } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Seg } from "../../ui/Seg.tsx";
import type { AgentDrafts } from "./AgentPage.state.ts";
import { effortApplies, statedModel, thinkingChoices } from "./Agents.model.ts";
import { CatalogSearch } from "./Agents.state.ts";
import { EffortField } from "./EffortField.tsx";
import { ModelFacts } from "./ModelFacts.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { UpstreamField } from "./UpstreamField.tsx";
import "./agent-page.css";

export function ModelFields({
  drafts: d,
  save,
  currentId,
  fresh,
}: {
  drafts: AgentDrafts;
  save: Save;
  currentId: string | null;
  fresh?: boolean;
}) {
  const search = useRef<CatalogSearch | null>(null);
  if (search.current === null) {
    search.current = new CatalogSearch((q) =>
      searchCatalog(d.providerId.value, q),
    );
  }
  useEffect(() => () => search.current?.dispose(), []);
  const rows = providers.value ?? [];
  const wire = rows.find((p) => p.id === d.providerId.value)?.wire;
  const model = d.model.value;
  const picked = statedModel(model, d.windowText.value, d.takesTools.value);
  const busy = save.busy;
  return (
    <>
      <ModelPicker
        save={save}
        search={search.current}
        providers={byName(rows)}
        providerId={d.providerId.value}
        model={
          picked === null ? null : { id: picked.id, meta: modelMeta(picked) }
        }
        changing={d.changing.value}
        cancellable={d.cancellable}
        currentId={currentId}
        matchMeta={modelMeta}
        autofocus={!fresh}
        onChange={() => d.change()}
        onCancel={() => d.cancel()}
        onProvider={(id) => d.chooseProvider(id)}
        onPick={(m) => d.pick(m, fixedThinking(m) !== null)}
      />
      {picked !== null && (
        <div class="agent-page-settings">
          {!picked.described && (
            <ModelFacts
              save={save}
              window={d.windowText.value}
              tools={d.takesTools.value}
              busy={busy}
              onWindow={(value) => {
                d.windowText.value = value;
                save.touch();
              }}
              onTools={(value) => {
                d.takesTools.value = value;
                save.touch();
              }}
            />
          )}
          {wire === "openrouter" && (
            <UpstreamField
              providerId={d.providerId.value}
              model={picked}
              value={d.upstream.value}
              skip4Bit={d.skip4Bit.value}
              busy={busy}
              save={save}
              onChange={(value) => {
                d.upstream.value = value;
                save.touch();
              }}
              onSkip4Bit={(value) => {
                d.skip4Bit.value = value;
                save.touch();
              }}
            />
          )}
          <div class="field">
            <span class="label">Thinking</span>
            <Seg
              label="Thinking"
              name="thinking"
              options={thinkingChoices(picked).map((c) => ({
                value: c.value ?? ("default" as const),
                label: c.label,
                disabled: busy,
              }))}
              value={
                (fixedThinking(picked) === null ? d.thinking.value : null) ??
                "default"
              }
              onPick={(value) => {
                d.thinking.value = value === "default" ? null : value;
                save.touch();
              }}
            />
          </div>
          {wire !== undefined && effortApplies(model, d.thinking.value) && (
            <EffortField
              wire={wire}
              value={d.effort.value}
              busy={busy}
              onChange={(value) => {
                d.effort.value = value;
                save.touch();
              }}
            />
          )}
        </div>
      )}
    </>
  );
}
