// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A decision's page under Config: the crumb is the head, its own step
// the switcher to the other decisions; then Status, whether it is asked
// and which decider answers, and Options, what the decider is told each
// answer means, each its own card and form. A decision is the code's,
// so there is no Delete; Reset to default fills the option boxes with
// the code's texts. The aside has its last 30 days.

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
import { count } from "../../lib/format.ts";
import { configDecisionHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Finder } from "../../ui/Finder.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Select } from "../../ui/Select.tsx";
import { Setting, SettingHint } from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
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
import { DraftFoot } from "./DraftFoot.tsx";
import { money } from "./Overview.model.ts";
import "./decider-page.css";

const STEPS = [
  zoneStep("Config"),
  { label: "Decisions", href: "/config/decisions" },
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
      menu={decision !== null ? <Switcher decision={decision} /> : undefined}
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

function Switcher({ decision }: { decision: DecisionSummary }) {
  const list = [...(decisions.value ?? [])].sort((a, b) =>
    DECISION_WORDS[a.id].title.localeCompare(DECISION_WORDS[b.id].title),
  );
  const title = DECISION_WORDS[decision.id].title;
  if (list.length < 2) return <span class="page-crumb-on">{title}</span>;
  return (
    <Finder
      label="Decisions"
      triggerClass="page-pill"
      title={title}
      trigger={
        <>
          <span class="cut">{title}</span>
          <Icon name="chevron" size={14} class="page-pill-chevron" />
        </>
      }
      options={list.map((d) => ({
        value: d.id,
        label: DECISION_WORDS[d.id].title,
        href: configDecisionHref(d.id),
      }))}
      value={decision.id}
      wide
      placeholder="Find a decision"
      none="No decision matches"
    />
  );
}

// the kept texts by option key: what a card that saves only the status
// sends for the options
const keptTexts = (d: DecisionSummary): Record<string, string> =>
  Object.fromEntries(d.options.map((o) => [o.key, o.description]));

// one decision's cards, made again for another, so a save still running
// for the last one holds nothing here
function Cards({
  decision,
  list,
}: {
  decision: DecisionSummary;
  list: DeciderSummary[];
}) {
  // a card is saving: each save sends the whole decision, so the other
  // waits rather than send what it is about to change
  const saving = useSignal(false);
  return (
    <div class="decider-page">
      <Status decision={decision} list={list} saving={saving} />
      <Options decision={decision} saving={saving} />
    </div>
  );
}

// runs a card's save with the page's lock held
async function locked(saving: Signal<boolean>, call: () => Promise<void>) {
  saving.value = true;
  try {
    await call();
  } finally {
    saving.value = false;
  }
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
  // the save is made once, so it reads the latest row when it runs
  const latest = useRef(decision);
  latest.current = decision;
  // the saved settings, to follow them when they change under the card
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
  // a decider deleted since hands over to the default
  const held = heldDecider(list, deciderId.value);
  const save = useSave(
    () =>
      locked(saving, async () => {
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
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  const busy = save.busy;
  const dirty =
    enabled.value !== decision.enabled ||
    held !== heldDecider(list, decision.deciderId ?? "");
  const reset = () => {
    enabled.value = decision.enabled;
    deciderId.value = heldDecider(list, decision.deciderId ?? "");
  };
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
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
    </form>
  );
}

function Options({
  decision,
  saving,
}: {
  decision: DecisionSummary;
  saving: Signal<boolean>;
}) {
  // one box per option, its keys fixed for the decision
  const texts = useMemo(
    () =>
      Object.fromEntries(
        decision.options.map((o) => [o.key, signal(o.description)]),
      ) as Record<string, Signal<string>>,
    [decision.id],
  );
  const latest = useRef(decision);
  latest.current = decision;
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
      locked(saving, async () => {
        const was = latest.current;
        const saved = await saveDecision(
          was.id,
          decisionBody(was, {
            enabled: was.enabled,
            // a decider deleted since is no decider to send
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
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  const busy = save.busy;
  const dirty = decision.options.some(
    (o) => texts[o.key]!.value.trim() !== o.description,
  );
  const changed = differsFromDefault(decision, held());
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(
          decision.options.reduce<ReturnType<typeof at>>(
            (found, o) =>
              found ??
              at(optionField(o.key), optionProblem(texts[o.key]!.value)),
            null,
          ),
        );
      }}
    >
      <Setting
        title="Options"
        foot={
          <Foot
            save={save}
            dirty={dirty && !saving.value}
            label="Save"
            stack={dirty}
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
                  disabled={!dirty || busy}
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
    </form>
  );
}

function Aside({ decision }: { decision: DecisionSummary }) {
  const known =
    decisionUsage.value?.of === decision.id ? decisionUsage.value : null;
  const usage = known?.usage ?? null;
  return (
    <AsideSection
      label="Last 30 days"
      action={
        <a class="split-link" href="/monitor">
          Usage
        </a>
      }
    >
      {known === null ? (
        <p class="split-empty">Loading</p>
      ) : usage === null ? (
        <p class="split-empty">Did not load.</p>
      ) : (
        <>
          <AsideLine label="Answers">{count(usage.answers)}</AsideLine>
          <AsideLine label="Tokens">{count(usage.tokens)}</AsideLine>
          <AsideLine label="Cost">
            {usage.cost === null ? "not priced" : money(usage.cost)}
          </AsideLine>
        </>
      )}
    </AsideSection>
  );
}
