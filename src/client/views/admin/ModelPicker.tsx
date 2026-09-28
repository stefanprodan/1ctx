// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "preact/hooks";
import type { CatalogMatch } from "../../../shared/contracts/provider.ts";
import { Icon } from "../../lib/icons.tsx";
import type { Save } from "../../lib/save.ts";
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
import type { CatalogSearch } from "./Agents.state.ts";
import "./agents.css";
import "./model-picker.css";

export function ModelPicker({
  save,
  search: s,
  providers,
  providerId,
  model,
  changing,
  cancellable,
  currentId,
  matchMeta,
  autofocus = true,
  onChange,
  onCancel,
  onProvider,
  onPick,
}: {
  save: Save;
  search: CatalogSearch;
  // the caller orders them
  providers: readonly { id: string; name: string }[];
  providerId: string;
  model: { id: string; meta: string } | null;
  changing: boolean;
  cancellable: boolean;
  currentId: string | null;
  matchMeta: (match: CatalogMatch) => string;
  // false on a new form: the search waits for a click
  autofocus?: boolean;
  onChange: () => void;
  onCancel: () => void;
  onProvider: (id: string) => void;
  onPick: (match: CatalogMatch) => void;
}) {
  const busy = save.busy;
  const providerName = providers.find((p) => p.id === providerId)?.name ?? "";
  // a closed search keeps no query for the next Change, and another
  // provider's catalog starts empty, whatever moved the provider
  useEffect(() => {
    if (!changing) s.clear();
  }, [changing]);
  useEffect(() => s.clear(), [providerId]);
  const box = useRef<HTMLInputElement | null>(null);
  // Change and a pick move the caret: into the search, or back to Change
  const into = useRef(autofocus);
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
    onCancel();
    save.touch();
  };
  return (
    <>
      {changing ? (
        <div class="model-picker-change">
          <div class="field model-picker-search">
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
                disabled={busy || providerId === ""}
                placeholder="Type part of the model's name or id"
                value={s.query.value}
                onInput={(e) =>
                  s.type((e.currentTarget as HTMLInputElement).value)
                }
                // the browser clears a search on Escape; an empty one
                // takes the change back
                onKeyDown={(e) => {
                  if (e.key !== "Escape" || s.query.value !== "") return;
                  if (cancellable) cancel();
                }}
              />
            </div>
          </div>
          <Finder
            label="Providers"
            class="model-picker-picker"
            triggerClass="model-picker-provider"
            title={providerName}
            disabled={busy}
            trigger={
              <>
                <span class="model-picker-provider-key">Provider</span>
                <span class="model-picker-provider-name">{providerName}</span>
                <Icon
                  name="chevron"
                  size={14}
                  class="model-picker-provider-chevron"
                />
              </>
            }
            options={providers.map((p) => ({ value: p.id, label: p.name }))}
            value={providerId}
            mono
            align="right"
            placeholder="Find a provider"
            none="No provider matches"
            onPick={(id) => {
              onProvider(id);
              s.clear();
              save.touch();
              if (!touch()) box.current?.focus();
            }}
          />
          {cancellable && (
            <button type="button" class="btn" disabled={busy} onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div class="model-picker-model">
          <span class="model-picker-model-words">
            {model === null ? (
              <span class="model-picker-model-meta">
                {providerName} · no model picked
              </span>
            ) : (
              <>
                <span class="model-picker-model-id">{model.id}</span>
                <span class="model-picker-model-meta">
                  {[providerName, model.meta]
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
              onChange();
            }}
          >
            Change
          </button>
        </div>
      )}
      {changing && s.query.value.trim() !== "" && (
        <div class="model-picker-results">
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
                    onPick(m);
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
                  <RowsMeta>{matchMeta(m)}</RowsMeta>
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
