// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A decider's model, its page's Model card and New decider alike, as an
// agent's is: at rest the model's id over the provider and what the
// catalog said, and Change; Change opens the decisions catalog search in
// its place with the provider beside it, only those whose wire answers
// decisions, and Cancel. A provider change clears the model.

import { useEffect, useRef } from "preact/hooks";
import { providers, searchCatalog } from "../../data/providers.ts";
import { Icon } from "../../lib/icons.tsx";
import type { Save } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { touch } from "../../lib/touch.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Finder } from "../../ui/Finder.tsx";
import {
  RowsBad,
  RowsButton,
  RowsList,
  RowsMeta,
  RowsNote,
  RowsTag,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { CatalogSearch } from "./Agents.state.ts";
import type { DeciderDrafts } from "./DeciderPage.state.ts";
import { deciderMeta, deciderProviders } from "./Deciders.model.ts";
import "./agents.css";
import "./decider-page.css";

export function DeciderModelFields({
  drafts: d,
  save,
  currentId,
  fresh,
}: {
  drafts: DeciderDrafts;
  save: Save;
  // the saved model, tagged current in the results
  currentId: string | null;
  // New decider: the search takes the caret on arrival, with a mouse
  fresh?: boolean;
}) {
  const search = useRef<CatalogSearch | null>(null);
  if (search.current === null) {
    search.current = new CatalogSearch((q) =>
      searchCatalog(d.providerId.value, q, "decisions"),
    );
  }
  useEffect(() => () => search.current?.dispose(), []);
  const s = search.current;
  const offered = byName(deciderProviders(providers.value ?? []));
  const providerName =
    offered.find((p) => p.id === d.providerId.value)?.name ?? "";
  const busy = save.busy;
  const changing = d.changing.value;
  const model = d.model.value;
  // a closed search keeps no query for the next Change
  useEffect(() => {
    if (!changing) s.clear();
  }, [changing]);
  const box = useRef<HTMLInputElement | null>(null);
  // Change and a pick move the caret: into the search, or back to Change
  const into = useRef(fresh === true);
  const back = useRef(false);
  useEffect(() => {
    if (changing && into.current && !touch()) box.current?.focus();
    into.current = false;
  }, [changing]);
  const changeRef = (el: HTMLButtonElement | null) => {
    if (el === null || !back.current) return;
    back.current = false;
    el.focus();
  };
  const cancel = () => {
    back.current = true;
    d.cancel();
    save.touch();
  };
  return (
    <>
      {changing ? (
        <div class="decider-page-change">
          <div class="field decider-page-search">
            <div class="agents-search">
              <Icon name="search" size={14} class="agents-search-icon" />
              <input
                type="search"
                name="model"
                class="agents-search-input"
                autocomplete="off"
                spellcheck={false}
                ref={box}
                aria-label="Model"
                aria-invalid={save.fieldError("model") !== null || undefined}
                disabled={busy || d.providerId.value === ""}
                placeholder="Type part of the model's name or id"
                value={s.query.value}
                onInput={(e) =>
                  s.type((e.currentTarget as HTMLInputElement).value)
                }
                // the browser clears a search on Escape; an empty one
                // takes the change back
                onKeyDown={(e) => {
                  if (e.key !== "Escape" || s.query.value !== "") return;
                  if (d.cancellable) cancel();
                }}
              />
            </div>
          </div>
          <Finder
            label="Providers"
            class="decider-page-picker"
            triggerClass="decider-page-provider"
            title={providerName}
            disabled={busy}
            trigger={
              <>
                <span class="decider-page-provider-key">Provider</span>
                <span class="decider-page-provider-name">{providerName}</span>
                <Icon
                  name="chevron"
                  size={14}
                  class="decider-page-provider-chevron"
                />
              </>
            }
            options={offered.map((p) => ({ value: p.id, label: p.name }))}
            value={d.providerId.value}
            mono
            align="right"
            placeholder="Find a provider"
            none="No provider matches"
            onPick={(id) => {
              d.chooseProvider(id);
              s.clear();
              save.touch();
              // the next step is the search in the new catalog
              if (!touch()) box.current?.focus();
            }}
          />
          {d.cancellable && (
            <button type="button" class="btn" disabled={busy} onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div class="decider-page-model">
          <span class="decider-page-model-words">
            {model === null ? (
              <span class="decider-page-model-meta">
                {providerName} · no model picked
              </span>
            ) : (
              <>
                <span class="decider-page-model-id">{model.id}</span>
                <span class="decider-page-model-meta">
                  {[providerName, deciderMeta(model)]
                    .filter((p) => p !== "")
                    .join(" · ")}
                </span>
              </>
            )}
          </span>
          <button
            type="button"
            class="btn"
            disabled={busy}
            ref={changeRef}
            onClick={() => {
              into.current = true;
              d.change();
            }}
          >
            Change
          </button>
        </div>
      )}
      {changing && s.query.value.trim() !== "" && (
        <div class="decider-page-results">
          <RowsList>
            {s.error.value ? (
              <RowsNote>
                <RowsBad>{s.error.value}</RowsBad>
              </RowsNote>
            ) : s.busy.value ? (
              <RowsNote>Searching</RowsNote>
            ) : s.matches.value.length === 0 ? (
              <RowsNote>Nothing in the catalog matches.</RowsNote>
            ) : (
              s.matches.value.map((m) => (
                <RowsButton
                  key={m.id}
                  onClick={() => {
                    back.current = true;
                    d.pick(m);
                    s.clear();
                    save.touch();
                  }}
                >
                  <RowsTitle
                    name={
                      m.id === currentId ? (
                        <>
                          <span class="cut">{m.name}</span>
                          <RowsTag>current</RowsTag>
                        </>
                      ) : (
                        m.name
                      )
                    }
                    sub={m.name === m.id ? undefined : m.id}
                    mono={m.name === m.id}
                  />
                  <RowsMeta>{deciderMeta(m)}</RowsMeta>
                </RowsButton>
              ))
            )}
          </RowsList>
        </div>
      )}
      <FieldError save={save} field="model" />
      <FieldError save={save} field="provider" />
    </>
  );
}
