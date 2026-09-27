// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A decision's form: On or Off, the decider asked (the default one
// unless another is picked) and what the decider is told each option
// means. It stays open after a save and shows the kept texts. Reset to
// default, shown while a box differs from the text in code, fills the
// boxes with it for the admin to save.

import { type Signal, signal, useSignal } from "@preact/signals";
import { useEffect, useMemo, useRef } from "preact/hooks";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import type { DecisionSummary } from "../../../shared/contracts/decision.ts";
import { saveDecision } from "../../data/decisions.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  DECISION_WORDS,
  deciderChoices,
  decisionBody,
  decisionFieldOf,
  defaultTexts,
  differsFromDefault,
  heldDecider,
  optionField,
  optionLabel,
  optionProblem,
} from "./Decisions.model.ts";
import "./agents.css";

const SWITCH = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

export function DecisionForm({
  decision,
  deciders,
  onDone,
}: {
  decision: DecisionSummary;
  deciders: DeciderSummary[];
  onDone: () => void;
}) {
  const words = DECISION_WORDS[decision.id];
  const enabled = useSignal(decision.enabled);
  const deciderId = useSignal(decision.deciderId ?? "");
  // one box per option, its keys fixed for the decision
  const texts = useMemo(
    () =>
      Object.fromEntries(
        decision.options.map((o) => [o.key, signal(o.description)]),
      ) as Record<string, Signal<string>>,
    [decision.id],
  );
  const kept = decision.options.map((o) => o.description).join("\n");
  // a save answers the settings kept, which the form then shows
  useEffect(() => {
    enabled.value = decision.enabled;
    deciderId.value = heldDecider(deciders, decision.deciderId ?? "");
    for (const o of decision.options) texts[o.key]!.value = o.description;
  }, [decision.enabled, decision.deciderId, kept]);
  // a decider deleted on the same page hands over to the default
  useEffect(() => {
    deciderId.value = heldDecider(deciders, deciderId.value);
  }, [deciders]);
  // what the boxes hold now, by option key
  const held = (): Record<string, string> =>
    Object.fromEntries(
      decision.options.map((o) => [o.key, texts[o.key]!.value]),
    );
  const save = useSave(async () => {
    await saveDecision(
      decision.id,
      decisionBody(decision, {
        enabled: enabled.value,
        deciderId: deciderId.value,
        texts: held(),
      }),
    );
  }, decisionFieldOf);
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  const busy = save.busy;
  const invalid = (field: string) => save.fieldError(field) !== null;
  const text = (key: string) => texts[key]!.value.trim();
  const dirty =
    enabled.value !== decision.enabled ||
    deciderId.value !== (decision.deciderId ?? "") ||
    decision.options.some((o) => text(o.key) !== o.description);
  const changed = differsFromDefault(decision, held());
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(
      decision.options.reduce<ReturnType<typeof at>>(
        (found, o) =>
          found ?? at(optionField(o.key), optionProblem(texts[o.key]!.value)),
        null,
      ),
    );
  };
  return (
    <form class="agents-form" ref={form} onSubmit={submit}>
      <div class="pair">
        <div class="field">
          <span class="label">Status</span>
          <Seg
            label="Status"
            name="enabled"
            invalid={invalid("enabled")}
            options={SWITCH.map((o) => ({ ...o, disabled: busy }))}
            value={enabled.value ? "on" : "off"}
            onPick={(value) => {
              enabled.value = value === "on";
              save.touch();
            }}
          />
          {invalid("enabled") ? (
            <FieldError save={save} field="enabled" />
          ) : (
            <span class="hint">{words.hint}</span>
          )}
        </div>
        <div class="field">
          <span class="label">Decider</span>
          <Select
            label="Decider"
            name="decider"
            invalid={invalid("decider")}
            disabled={busy}
            value={deciderId.value}
            options={deciderChoices(deciders)}
            onChange={(picked) => {
              deciderId.value = picked;
              save.touch();
            }}
          />
          {invalid("decider") ? (
            <FieldError save={save} field="decider" />
          ) : (
            <span class="hint">
              {deciders.length === 0
                ? "Stays off until a decider is added."
                : "Default follows the decider marked default."}
            </span>
          )}
        </div>
        {decision.options.map((o) => {
          const field = optionField(o.key);
          return (
            <label key={o.key} class="field pair-wide">
              <span class="label">{optionLabel(decision.id, o.key)}</span>
              <textarea
                name={field}
                class="agents-prompt"
                rows={3}
                aria-invalid={invalid(field) || undefined}
                disabled={busy}
                value={texts[o.key]!.value}
                onInput={save.bind(texts[o.key]!)}
              />
              <FieldError save={save} field={field} />
            </label>
          );
        })}
      </div>
      <Foot
        save={save}
        dirty={dirty}
        label="Save"
        start={
          changed ? (
            <button
              type="button"
              class="btn"
              disabled={busy}
              onClick={() => {
                const fill = defaultTexts(decision);
                for (const o of decision.options) {
                  texts[o.key]!.value = fill[o.key]!;
                }
                save.touch();
              }}
            >
              Reset to default
            </button>
          ) : (
            <span />
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
