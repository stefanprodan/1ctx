// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The model's fields, the agent page's Model card and New agent alike.
// At rest the model's id, the provider and the facts under it, and
// Change; Change opens the catalog search in the model's place with the
// provider beside it and Cancel, the results under them in a frame that
// scrolls. Under the model, the settings it takes: the window and tools
// a silent catalog leaves to the admin, the OpenRouter endpoint tried
// first, thinking and effort. The rules are the agent form's: a
// provider change clears the model, the effort and the preferred
// provider; a pick clears a preferred provider chosen for another
// model, a thinking the model fixes and the stated facts.

import { useEffect, useRef } from "preact/hooks";
import { fixedThinking } from "../../../shared/thinking.ts";
import { modelMeta } from "../../agents/meta.ts";
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
import { Seg } from "../../ui/Seg.tsx";
import type { AgentDrafts } from "./AgentPage.state.ts";
import { effortApplies, statedModel, thinkingChoices } from "./Agents.model.ts";
import { CatalogSearch } from "./Agents.state.ts";
import { EffortField } from "./EffortField.tsx";
import { ModelFacts } from "./ModelFacts.tsx";
import { UpstreamField } from "./UpstreamField.tsx";
import "./agent-page.css";
import "./agents.css";

export function ModelFields({
  drafts: d,
  save,
  currentId,
  fresh,
}: {
  drafts: AgentDrafts;
  save: Save;
  // the saved model, tagged current in the results
  currentId: string | null;
  // a new agent: the search is open at first, and waits for a click
  fresh?: boolean;
}) {
  const search = useRef<CatalogSearch | null>(null);
  if (search.current === null) {
    search.current = new CatalogSearch((q) =>
      searchCatalog(d.providerId.value, q),
    );
  }
  useEffect(() => () => search.current?.dispose(), []);
  const s = search.current;
  const rows = providers.value ?? [];
  const wire = rows.find((p) => p.id === d.providerId.value)?.wire;
  const model = d.model.value;
  const picked = statedModel(model, d.windowText.value, d.takesTools.value);
  const busy = save.busy;
  const providerName =
    rows.find((p) => p.id === d.providerId.value)?.name ?? "";
  const changing = d.changing.value;
  // the search opened by Change takes the caret once, with a mouse
  const focused = useRef(fresh === true);
  if (!changing) focused.current = false;
  // a closed search keeps no query for the next Change
  useEffect(() => {
    if (!changing) s.clear();
  }, [changing]);
  const box = useRef<HTMLInputElement | null>(null);
  // the row that closes takes the focus with it: Change gets it back
  const back = useRef(false);
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
        <div class="agent-page-change">
          <div class="field agent-page-search">
            <div class="agents-search">
              <Icon name="search" size={14} class="agents-search-icon" />
              <input
                type="search"
                name="model"
                class="agents-search-input"
                autocomplete="off"
                spellcheck={false}
                // a mouse's Change puts the caret here; a touch leaves
                // the keyboard down
                ref={(el) => {
                  box.current = el;
                  if (el !== null && !focused.current && !touch()) {
                    focused.current = true;
                    el.focus();
                  }
                }}
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
            class="agent-page-picker"
            triggerClass="agent-page-provider"
            title={providerName}
            disabled={busy}
            trigger={
              <>
                <span class="agent-page-provider-key">Provider</span>
                <span class="agent-page-provider-name">{providerName}</span>
                <Icon
                  name="chevron"
                  size={14}
                  class="agent-page-provider-chevron"
                />
              </>
            }
            options={byName(rows).map((p) => ({
              value: p.id,
              label: p.name,
            }))}
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
      ) : model === null ? (
        <div class="agent-page-model">
          <span class="agent-page-model-words">
            <span class="agent-page-model-meta">
              {providerName} · no model picked
            </span>
          </span>
          <button
            type="button"
            class="btn"
            disabled={busy}
            ref={changeRef}
            onClick={() => d.change()}
          >
            Change
          </button>
        </div>
      ) : (
        <div class="agent-page-model">
          <span class="agent-page-model-words">
            <span class="agent-page-model-id">{picked!.id}</span>
            <span class="agent-page-model-meta">
              {[providerName, modelMeta(picked!)]
                .filter((p) => p !== "")
                .join(" · ")}
            </span>
          </span>
          <button
            type="button"
            class="btn"
            disabled={busy}
            ref={changeRef}
            onClick={() => d.change()}
          >
            Change
          </button>
        </div>
      )}
      {changing && s.query.value.trim() !== "" && (
        <div class="agent-page-results">
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
                    d.pick(m, fixedThinking(m) !== null);
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
                  <RowsMeta>{modelMeta(m)}</RowsMeta>
                </RowsButton>
              ))
            )}
          </RowsList>
        </div>
      )}
      <FieldError save={save} field="model" />
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
              busy={busy}
              save={save}
              onChange={(value) => {
                d.upstream.value = value;
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
