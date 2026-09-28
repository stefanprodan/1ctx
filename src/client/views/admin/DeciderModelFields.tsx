// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "preact/hooks";
import { providers, searchCatalog } from "../../data/providers.ts";
import type { Save } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { CatalogSearch } from "./Agents.state.ts";
import type { DeciderDrafts } from "./DeciderPage.state.ts";
import { deciderMeta, deciderProviders } from "./Deciders.model.ts";
import { ModelPicker } from "./ModelPicker.tsx";

export function DeciderModelFields({
  drafts: d,
  save,
  currentId,
  autofocus,
}: {
  drafts: DeciderDrafts;
  save: Save;
  currentId: string | null;
  autofocus?: boolean;
}) {
  const search = useRef<CatalogSearch | null>(null);
  if (search.current === null) {
    search.current = new CatalogSearch((q) =>
      searchCatalog(d.providerId.value, q, "decisions"),
    );
  }
  useEffect(() => () => search.current?.dispose(), []);
  const model = d.model.value;
  return (
    <ModelPicker
      save={save}
      search={search.current}
      providers={byName(deciderProviders(providers.value ?? []))}
      providerId={d.providerId.value}
      model={model === null ? null : { id: model.id, meta: deciderMeta(model) }}
      changing={d.changing.value}
      cancellable={d.cancellable}
      currentId={currentId}
      matchMeta={deciderMeta}
      autofocus={autofocus}
      onChange={() => d.change()}
      onCancel={() => d.cancel()}
      onProvider={(id) => d.chooseProvider(id)}
      onPick={(m) => d.pick(m)}
    />
  );
}
