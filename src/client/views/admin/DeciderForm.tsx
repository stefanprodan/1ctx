// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A decider's form: the name, the provider (only those whose wire
// answers decisions), the model found by typing into that provider's
// decisions catalog, and whether it is the default. An open row adds
// Check, which asks the saved decider one yes/no and says how long it
// took and what it cost, and Delete, asked once in place.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import {
  checkDecider,
  createDecider,
  deciders,
  deleteDecider,
  updateDecider,
} from "../../data/deciders.ts";
import { searchCatalog } from "../../data/providers.ts";
import { Icon } from "../../lib/icons.tsx";
import { nameProblem, shapedInput } from "../../lib/names.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import {
  RowsBad,
  RowsButton,
  RowsEnd,
  RowsLine,
  RowsList,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { CatalogSearch } from "./Agents.state.ts";
import {
  checkLine,
  deciderFieldOf,
  deciderMeta,
  deciderProviders,
  heldProvider,
  providerProblem,
} from "./Deciders.model.ts";
import { DefaultField } from "./DefaultField.tsx";
import { Picks } from "./Picks.tsx";
import "./agents.css";

// what the form keeps of a pick: what the row shows of it
type Picked = {
  id: string;
  contextLength: number | null;
  promptPrice: number | null;
};

export function DeciderForm({
  decider,
  providers,
  onDone,
}: {
  decider: DeciderSummary | null;
  providers: ProviderSummary[];
  onDone: () => void;
}) {
  const offered = deciderProviders(providers);
  const name = useSignal(decider?.name ?? "");
  const providerId = useSignal(decider?.providerId ?? offered[0]?.id ?? "");
  const model = useSignal<Picked | null>(
    decider === null
      ? null
      : {
          id: decider.model,
          contextLength: decider.contextLength,
          promptPrice: decider.promptPrice,
        },
  );
  const isDefault = useSignal(decider?.default ?? false);
  const asking = useSignal(false);
  const checked = useSignal<string | null>(null);
  const search = useRef<CatalogSearch | null>(null);
  if (search.current === null) {
    search.current = new CatalogSearch((q) =>
      searchCatalog(providerId.value, q, "decisions"),
    );
  }
  useEffect(() => () => search.current?.dispose(), []);
  const s = search.current;
  useEffect(() => {
    const next = heldProvider(offered, providerId.value);
    if (next === providerId.value) return;
    providerId.value = next;
    model.value = null;
    s.clear();
  }, [providers]);
  const save = useSave(async () => {
    const body = {
      name: name.value.trim(),
      providerId: providerId.value,
      model: model.value?.id ?? "",
      // sent only when flipped, so a save never moves a mark set since
      ...(isDefault.value !== (decider?.default ?? false)
        ? { default: isDefault.value }
        : {}),
    };
    if (decider) await updateDecider(decider.id, body);
    else await createDecider(body);
    onDone();
  }, deciderFieldOf);
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const busy = save.busy;
  const chooseProvider = (id: string) => {
    if (id === providerId.value) return;
    providerId.value = id;
    model.value = null;
    s.clear();
    save.touch();
  };
  const dirty =
    decider === null ||
    name.value.trim() !== decider.name ||
    providerId.value !== decider.providerId ||
    model.value?.id !== decider.model ||
    isDefault.value !== decider.default;
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      at("name", nameProblem(name.value)) ??
        at("provider", providerProblem(offered, providerId.value)) ??
        at("model", model.value === null ? "Pick a model" : null),
    );
  };
  // the saved decider answers, whatever the form holds now; its words
  // start with the provider's name, so they never land on a field
  const check = () => {
    checked.value = null;
    void save.act(
      "check",
      async () => {
        checked.value = checkLine(await checkDecider(decider!.id));
      },
      { whole: true },
    );
  };
  const picked = model.value;
  return (
    <form class="agents-form" ref={form} onSubmit={submit}>
      <div class="pair">
        <label class="field">
          <span class="label label-required">Name</span>
          <input
            name="name"
            aria-required="true"
            autocomplete="off"
            spellcheck={false}
            placeholder="jev"
            aria-invalid={invalid("name") || undefined}
            disabled={busy}
            value={name.value}
            onInput={(e) => {
              name.value = shapedInput(e);
              save.touch();
            }}
          />
          <FieldError save={save} field="name" />
        </label>
        <div class="field">
          <span class="label label-required">Provider</span>
          <Picks
            name="provider"
            choices={offered.map((p) => ({ value: p.id, label: p.name }))}
            value={providerId.value}
            busy={busy}
            onPick={chooseProvider}
          />
          <FieldError save={save} field="provider" />
        </div>
        <div class="field pair-wide">
          <span class="label label-required">Model</span>
          {picked ? (
            <RowsList>
              <RowsLine flush>
                <RowsTitle name={picked.id} mono />
                <RowsMeta>{deciderMeta(picked)}</RowsMeta>
                <RowsEnd>
                  <button
                    type="button"
                    class="btn btn-small"
                    disabled={busy}
                    onClick={() => {
                      model.value = null;
                      save.touch();
                    }}
                  >
                    Change
                  </button>
                </RowsEnd>
              </RowsLine>
            </RowsList>
          ) : (
            <div class="agents-search">
              <Icon name="search" size={14} class="agents-search-icon" />
              <input
                type="search"
                name="model"
                class="agents-search-input"
                autocomplete="off"
                spellcheck={false}
                aria-invalid={invalid("model") || undefined}
                disabled={busy || providerId.value === ""}
                placeholder="Type part of the model's name or id"
                value={s.query.value}
                onInput={(e) =>
                  s.type((e.currentTarget as HTMLInputElement).value)
                }
              />
            </div>
          )}
          {!picked && s.query.value.trim() !== "" && (
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
                      model.value = {
                        id: m.id,
                        contextLength: m.contextLength,
                        promptPrice: m.promptPrice,
                      };
                      s.clear();
                      save.touch();
                    }}
                  >
                    <RowsTitle name={m.name} sub={m.id} />
                    <RowsMeta>{deciderMeta(m)}</RowsMeta>
                  </RowsButton>
                ))
              )}
            </RowsList>
          )}
          <FieldError save={save} field="model" />
        </div>
        <DefaultField
          row={decider}
          on={isDefault}
          save={save}
          oldest={deciders.value?.[0]?.id}
          label="Default decider"
          hint="Features that ask a model a question ask this decider."
        />
      </div>
      <Foot
        save={save}
        dirty={dirty}
        label={decider ? "Save" : "Add decider"}
        above={
          // mounted empty so a screen reader announces the answer
          decider !== null && (
            <p class="agents-checked" role="status">
              {checked.value}
            </p>
          )
        }
        start={
          decider === null ? (
            <span />
          ) : (
            <>
              <AskDelete
                save={save}
                asking={asking}
                busy={busy}
                words={`Delete ${decider.name}?`}
                wordsClass="agents-ask-words"
                onDelete={() =>
                  void save.act("delete", () => deleteDecider(decider.id))
                }
              />
              {!asking.value && (
                <button
                  type="button"
                  class="btn"
                  disabled={busy}
                  onClick={check}
                >
                  {save.pending.value === "check" ? "Checking" : "Check"}
                </button>
              )}
            </>
          )
        }
        before={
          <button type="button" class="btn" onClick={onDone}>
            Cancel
          </button>
        }
      />
    </form>
  );
}
