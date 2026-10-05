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
import {
  effortApplies,
  resetsThinking,
  statedModel,
  thinkingChoices,
  thinkingHint,
} from "./Agents.model.ts";
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
  const picked = statedModel(
    model,
    d.windowText.value,
    d.takesTools.value,
    d.windowSaved,
  );
  const busy = save.busy;
  return (
    <>
      <ModelPicker
        save={save}
        search={search.current}
        providers={byName(rows)}
        providerId={d.providerId.value}
        model={
          picked === null
            ? null
            : { id: picked.id, meta: modelMeta(picked, wire) }
        }
        changing={d.changing.value}
        cancellable={d.cancellable}
        currentId={currentId}
        matchMeta={(m) => modelMeta(m, wire)}
        autofocus={!fresh}
        onChange={() => d.change()}
        onCancel={() => d.cancel()}
        onProvider={(id) => d.chooseProvider(id)}
        onPick={(m) => d.pick(m, resetsThinking(m, wire, d.thinking.value))}
      />
      {picked !== null && (
        <div class="agent-page-settings">
          {!picked.described && (
            <ModelFacts
              save={save}
              window={d.windowText.value}
              tools={d.takesTools.value}
              suggested={d.suggested.value}
              busy={busy}
              onWindow={(value) => {
                d.windowText.value = value;
                d.suggested.value = false;
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
              options={thinkingChoices(picked, wire, d.thinking.value).map(
                (c) => ({
                  value: c.value ?? ("default" as const),
                  label: c.label,
                  disabled: busy,
                }),
              )}
              value={
                (fixedThinking(picked) === null ? d.thinking.value : null) ??
                "default"
              }
              onPick={(value) => {
                d.thinking.value = value === "default" ? null : value;
                save.touch();
              }}
            />
            {thinkingHint(wire) !== null && (
              <span class="hint">{thinkingHint(wire)}</span>
            )}
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
