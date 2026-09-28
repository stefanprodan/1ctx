// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, signal, useSignal } from "@preact/signals";
import { useMemo, useRef } from "preact/hooks";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import type { DecisionSummary } from "../../../shared/contracts/decision.ts";
import type { Params } from "../../app/params.ts";
import { zoneStep } from "../../app/zones.ts";
import { deciders, decidersError, decisionUsage } from "../../data/deciders.ts";
import {
  decisions,
  decisionsError,
  saveDecision,
} from "../../data/decisions.ts";
import { configDecisionHref, DECISIONS_HREF } from "../../lib/hrefs.ts";
import { at, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Page, PageSwitcher } from "../../ui/Page.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  Setting,
  SettingForm,
  SettingHint,
  SettingStack,
} from "../../ui/Setting.tsx";
import { Split } from "../../ui/Split.tsx";
import { SpendLines, UsageSection } from "./AdminAside.tsx";
import {
  byTitle,
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
import { DraftFoot } from "./DraftFoot.tsx";
import { holding, useLatest } from "./drafts.ts";
import "./decider-page.css";

const STEPS = [
  zoneStep("Config"),
  { label: "Decisions", href: DECISIONS_HREF },
];

const SWITCH = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

export function DecisionPage({ params }: { params: Params }) {
  const list = decisions.value;
  const decision = list?.find((d) => d.id === params.id) ?? null;
  const title =
    decision === null ? params.id : DECISION_WORDS[decision.id].title;
  const error = decisionsError.value ?? decidersError.value;
  return (
    <Page
      steps={STEPS}
      title={title}
      menu={
        decision !== null ? (
          <PageSwitcher
            label="Decisions"
            current={decision.id}
            name={title}
            items={byTitle(list ?? []).map((d) => ({
              id: d.id,
              label: DECISION_WORDS[d.id].title,
              href: configDecisionHref(d.id),
            }))}
            mono={false}
            placeholder="Find a decision"
            none="No decision matches"
          />
        ) : undefined
      }
      split
      loading={(list === null || deciders.value === null) && error === null}
      empty={
        list !== null && decision === null ? "No such decision." : undefined
      }
      error={error}
    >
      {decision !== null && deciders.value !== null && (
        <Split aside={<Aside decision={decision} />}>
          <Cards key={decision.id} decision={decision} list={deciders.value} />
        </Split>
      )}
    </Page>
  );
}

// the route takes the whole decision, so Status sends the kept texts
const keptTexts = (d: DecisionSummary): Record<string, string> =>
  Object.fromEntries(d.options.map((o) => [o.key, o.description]));

// remade per decision, so a save still running for the last holds nothing
function Cards({
  decision,
  list,
}: {
  decision: DecisionSummary;
  list: DeciderSummary[];
}) {
  // each save sends the whole decision, so the other card waits
  const saving = useSignal(false);
  return (
    <SettingStack>
      <Status decision={decision} list={list} saving={saving} />
      <Options decision={decision} saving={saving} />
    </SettingStack>
  );
}

function Status({
  decision,
  list,
  saving,
}: {
  decision: DecisionSummary;
  list: DeciderSummary[];
  saving: Signal<boolean>;
}) {
  const words = DECISION_WORDS[decision.id];
  const enabled = useSignal(decision.enabled);
  const deciderId = useSignal(heldDecider(list, decision.deciderId ?? ""));
  const latest = useLatest(decision);
  // follow the saved settings when they change under the card
  const seen = useRef(decision);
  if (seen.current !== decision) {
    if (enabled.value === seen.current.enabled) {
      enabled.value = decision.enabled;
    }
    if (deciderId.value === (seen.current.deciderId ?? "")) {
      deciderId.value = heldDecider(list, decision.deciderId ?? "");
    }
    seen.current = decision;
  }
  // a deleted decider falls back to the default
  const held = heldDecider(list, deciderId.value);
  const save = useSave(
    () =>
      holding(saving, async () => {
        const was = latest.current;
        const saved = await saveDecision(
          was.id,
          decisionBody(was, {
            enabled: enabled.value,
            deciderId: heldDecider(deciders.value ?? [], deciderId.value),
            texts: keptTexts(was),
          }),
        );
        enabled.value = saved.enabled;
        deciderId.value = saved.deciderId ?? "";
      }),
    decisionFieldOf,
  );
  const busy = save.busy;
  const dirty =
    enabled.value !== decision.enabled ||
    held !== heldDecider(list, decision.deciderId ?? "");
  const reset = () => {
    enabled.value = decision.enabled;
    deciderId.value = heldDecider(list, decision.deciderId ?? "");
  };
  return (
    <SettingForm save={save}>
      <Setting
        title="Status"
        line={words.hint}
        foot={
          <DraftFoot
            save={save}
            dirty={dirty}
            locked={saving.value}
            onDiscard={reset}
          />
        }
      >
        <div class="pair">
          <div class="field">
            <span class="label">Asked</span>
            <Seg
              label="Asked"
              name="enabled"
              invalid={save.fieldError("enabled") !== null}
              options={SWITCH.map((o) => ({ ...o, disabled: busy }))}
              value={enabled.value ? "on" : "off"}
              onPick={(value) => {
                enabled.value = value === "on";
                save.touch();
              }}
            />
            <FieldError save={save} field="enabled" />
          </div>
          <div class="field">
            <span class="label">Decider</span>
            <Select
              label="Decider"
              name="decider"
              invalid={save.fieldError("decider") !== null}
              disabled={busy}
              value={held}
              options={deciderChoices(list)}
              onChange={(picked) => {
                deciderId.value = picked;
                save.touch();
              }}
            />
            {save.fieldError("decider") !== null ? (
              <FieldError save={save} field="decider" />
            ) : (
              list.length === 0 && (
                <span class="hint">Stays off until a decider is added.</span>
              )
            )}
          </div>
        </div>
      </Setting>
    </SettingForm>
  );
}

function Options({
  decision,
  saving,
}: {
  decision: DecisionSummary;
  saving: Signal<boolean>;
}) {
  // the keys are fixed per decision
  const texts = useMemo(
    () =>
      Object.fromEntries(
        decision.options.map((o) => [o.key, signal(o.description)]),
      ) as Record<string, Signal<string>>,
    [decision.id],
  );
  const latest = useLatest(decision);
  const seen = useRef(decision);
  if (seen.current !== decision) {
    for (const o of decision.options) {
      const before = seen.current.options.find((x) => x.key === o.key);
      if (texts[o.key]!.value.trim() === before?.description) {
        texts[o.key]!.value = o.description;
      }
    }
    seen.current = decision;
  }
  const held = (): Record<string, string> =>
    Object.fromEntries(
      decision.options.map((o) => [o.key, texts[o.key]!.value]),
    );
  const save = useSave(
    () =>
      holding(saving, async () => {
        const was = latest.current;
        const saved = await saveDecision(
          was.id,
          decisionBody(was, {
            enabled: was.enabled,
            // a deleted decider falls back to the default
            deciderId: heldDecider(deciders.value ?? [], was.deciderId ?? ""),
            texts: Object.fromEntries(
              was.options.map((o) => [o.key, texts[o.key]!.value]),
            ),
          }),
        );
        for (const o of saved.options) texts[o.key]!.value = o.description;
      }),
    decisionFieldOf,
  );
  const busy = save.busy;
  const dirty = decision.options.some(
    (o) => texts[o.key]!.value.trim() !== o.description,
  );
  const changed = differsFromDefault(decision, held());
  return (
    <SettingForm
      save={save}
      check={() =>
        decision.options.reduce<ReturnType<typeof at>>(
          (found, o) =>
            found ?? at(optionField(o.key), optionProblem(texts[o.key]!.value)),
          null,
        )
      }
    >
      <Setting
        title="Options"
        foot={
          <Foot
            save={save}
            dirty={dirty && !saving.value}
            label="Save"
            inline
            start={
              <SettingHint>{dirty ? "Unsaved changes" : undefined}</SettingHint>
            }
            before={
              <>
                {changed && (
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
                )}
                <button
                  type="button"
                  class="btn"
                  disabled={!dirty || busy || saving.value}
                  onClick={() => {
                    for (const o of decision.options) {
                      texts[o.key]!.value = o.description;
                    }
                    save.touch();
                  }}
                >
                  Discard
                </button>
              </>
            }
          />
        }
      >
        {decision.options.map((o) => {
          const field = optionField(o.key);
          return (
            <label key={o.key} class="field">
              <span class="label">{optionLabel(decision.id, o.key)}</span>
              <textarea
                name={field}
                class="decider-page-option"
                rows={3}
                aria-invalid={save.fieldError(field) !== null || undefined}
                disabled={busy}
                value={texts[o.key]!.value}
                onInput={save.bind(texts[o.key]!)}
              />
              <FieldError save={save} field={field} />
            </label>
          );
        })}
      </Setting>
    </SettingForm>
  );
}

function Aside({ decision }: { decision: DecisionSummary }) {
  return (
    <UsageSection value={decisionUsage.valueFor(decision.id)}>
      {(usage) => (
        <SpendLines
          label="Answers"
          count={usage.answers}
          tokens={usage.tokens}
          cost={usage.cost}
        />
      )}
    </UsageSection>
  );
}
