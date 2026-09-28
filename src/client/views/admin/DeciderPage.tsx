// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
import { MAX_NAME } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import { navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  checkDecider,
  deciders,
  decidersError,
  deciderUsage,
  deleteDecider,
  loadDeciderUsage,
  updateDecider,
} from "../../data/deciders.ts";
import { decisions, loadDecisions } from "../../data/decisions.ts";
import { providersError } from "../../data/providers.ts";
import { says } from "../../lib/format.ts";
import { configDeciderHref, configDecisionHref } from "../../lib/hrefs.ts";
import { nameProblem, shapedInput } from "../../lib/names.ts";
import { at, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Page, PageSwitcher } from "../../ui/Page.tsx";
import { RowsCheck } from "../../ui/Rows.tsx";
import {
  Setting,
  SettingDelete,
  SettingForm,
  SettingStack,
} from "../../ui/Setting.tsx";
import { AsideSection, Split } from "../../ui/Split.tsx";
import { SpendLines, UsageSection } from "./AdminAside.tsx";
import { DeciderModelFields } from "./DeciderModelFields.tsx";
import { DeciderDrafts } from "./DeciderPage.state.ts";
import {
  askedBy,
  checkLine,
  deciderDeleteLine,
  deciderFieldOf,
} from "./Deciders.model.ts";
import { DECISION_WORDS } from "./Decisions.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { holding, useLatest, useRowDrafts, useShownRow } from "./drafts.ts";
import "./decider-page.css";

const LIST = "/admin/config/deciders";
const STEPS = [zoneStep("Config"), { label: "Deciders", href: LIST }];

export function DeciderPage({ params }: { params: Params }) {
  const list = deciders.value;
  const { row: decider, leaving } = useShownRow(
    list,
    params.name,
    (d) => d.name,
  );
  const drafts = useRowDrafts(decider, DeciderDrafts.of, (d, before, after) =>
    d.follow(before, after),
  );
  const error = decidersError.value ?? providersError.value;
  return (
    <Page
      steps={STEPS}
      title={params.name}
      titleMono
      menu={
        decider !== null ? (
          <PageSwitcher
            label="Deciders"
            current={decider.id}
            name={decider.name}
            items={byName(list ?? []).map((d) => ({
              id: d.id,
              label: d.name,
              href: configDeciderHref(d.name),
            }))}
            placeholder="Find a decider"
            none="No decider matches"
          />
        ) : undefined
      }
      split
      loading={list === null && error === null}
      empty={
        list !== null && decider === null && !leaving
          ? "No decider by that name."
          : undefined
      }
      error={error}
    >
      {decider !== null && drafts !== null && (
        <Split aside={<Aside decider={decider} />}>
          <SettingStack key={decider.id}>
            <Identity decider={decider} drafts={drafts} />
            <Model decider={decider} drafts={drafts} />
            {/* an answer is about the model that gave it */}
            <Check key={decider.model} decider={decider} />
            <SettingDelete
              title={`Delete ${decider.name}`}
              line={deciderDeleteLine(
                decider,
                list ?? [],
                askedBy(decider, decisions.value ?? []).length,
              )}
              ask={`Delete ${decider.name}?`}
              off={drafts.saving.value}
              onDelete={async () => {
                await deleteDecider(decider.id);
                // a decision that named it names none now
                void loadDecisions();
              }}
              leaveTo={LIST}
            />
          </SettingStack>
        </Split>
      )}
    </Page>
  );
}

// the mark only when flipped, so a save never moves a mark set since
const body = (d: DeciderSummary, over: Partial<DeciderSummary>) => {
  const next = { ...d, ...over };
  return {
    name: next.name,
    providerId: next.providerId,
    model: next.model,
    ...(next.default !== d.default ? { default: next.default } : {}),
  };
};

function Identity({
  decider,
  drafts: d,
}: {
  decider: DeciderSummary;
  drafts: DeciderDrafts;
}) {
  const latest = useLatest(decider);
  const save = useSave(
    () =>
      holding(d.saving, async () => {
        const was = latest.current;
        const saved = await updateDecider(
          was.id,
          body(was, { name: d.name.value.trim(), default: d.isDefault.value }),
        );
        d.resetGeneral(saved);
        if (saved.name !== was.name) {
          navigate(configDeciderHref(saved.name), true);
        }
      }),
    deciderFieldOf,
  );
  const name = d.name.value.trim();
  const taken = (deciders.value ?? []).some(
    (x) => x.name === name && x.id !== decider.id,
  );
  // the oldest keeps the mark while default: No hands it to the oldest
  const kept = decider.default && deciders.value?.[0]?.id === decider.id;
  const busy = save.busy;
  return (
    <SettingForm
      save={save}
      check={() => at("name", nameProblem(d.name.value))}
    >
      <Setting
        title="Identity"
        foot={
          <DraftFoot
            save={save}
            dirty={d.generalDirty(decider)}
            blocked={taken || name === ""}
            locked={d.saving.value}
            hint={
              taken ? <span class="error">{name} is taken.</span> : undefined
            }
            onDiscard={() => d.resetGeneral(decider)}
          />
        }
      >
        <label class="field decider-page-name">
          <span class="label">Name</span>
          <input
            name="name"
            autocomplete="off"
            spellcheck={false}
            maxLength={MAX_NAME}
            aria-invalid={save.fieldError("name") !== null || undefined}
            disabled={busy}
            value={d.name.value}
            onInput={(e) => {
              d.name.value = shapedInput(e);
              save.touch();
            }}
          />
          <FieldError save={save} field="name" />
        </label>
        <RowsCheck
          name="default"
          checked={d.isDefault.value}
          disabled={busy || kept}
          faint={kept}
          note={kept ? "Mark another decider to move it" : undefined}
          onChange={() => {
            d.isDefault.value = !d.isDefault.value;
            save.touch();
          }}
        >
          Default decider
        </RowsCheck>
      </Setting>
    </SettingForm>
  );
}

function Model({
  decider,
  drafts: d,
}: {
  decider: DeciderSummary;
  drafts: DeciderDrafts;
}) {
  const latest = useLatest(decider);
  const save = useSave(
    () =>
      holding(d.saving, async () => {
        const was = latest.current;
        const saved = await updateDecider(
          was.id,
          body(was, {
            providerId: d.providerId.value,
            model: d.model.value?.id ?? "",
          }),
        );
        d.resetModel(saved);
      }),
    deciderFieldOf,
  );
  return (
    <SettingForm
      save={save}
      check={() => at("model", d.model.value === null ? "Pick a model" : null)}
    >
      <Setting
        title="Model"
        foot={
          <DraftFoot
            save={save}
            dirty={d.modelDirty(decider)}
            blocked={d.model.value === null || d.changing.value}
            locked={d.saving.value}
            open={d.changing.value}
            onDiscard={() => d.resetModel(decider)}
          />
        }
      >
        <DeciderModelFields drafts={d} save={save} currentId={decider.model} />
      </Setting>
    </SettingForm>
  );
}

// the saved decider answers, whatever a draft holds
function Check({ decider }: { decider: DeciderSummary }) {
  const answer = useSignal<string | null>(null);
  const failed = useSignal<string | null>(null);
  const busy = useSignal(false);
  return (
    <Setting
      title="Check"
      line="Asks one yes or no question. Shows how long it took and what it cost."
      foot={
        <div class="decider-page-foot">
          <span class="decider-page-checked" role="status">
            {failed.value !== null ? (
              <span class="error">{failed.value}</span>
            ) : (
              answer.value
            )}
          </span>
          <button
            type="button"
            class="btn"
            disabled={busy.value}
            onClick={async () => {
              answer.value = null;
              failed.value = null;
              busy.value = true;
              try {
                answer.value = checkLine(await checkDecider(decider.id));
                // the answer is a usage row: the aside counts it
                void loadDeciderUsage(decider.id);
              } catch (err) {
                failed.value = says(err);
              } finally {
                busy.value = false;
              }
            }}
          >
            {busy.value ? "Checking" : "Check"}
          </button>
        </div>
      }
    />
  );
}

function Aside({ decider }: { decider: DeciderSummary }) {
  const asks = askedBy(decider, decisions.value ?? []);
  return (
    <>
      <UsageSection value={deciderUsage.valueFor(decider.id)}>
        {(usage) => (
          <SpendLines
            label="Answers"
            count={usage.answers}
            tokens={usage.tokens}
            cost={usage.cost}
          />
        )}
      </UsageSection>
      <AsideSection label="Asked by">
        {asks.length === 0 ? (
          <p class="split-empty">No decision.</p>
        ) : (
          asks.map((x) => (
            <div key={x.id} class="split-line">
              <a class="split-link" href={configDecisionHref(x.id)}>
                {DECISION_WORDS[x.id].title}
              </a>
            </div>
          ))
        )}
      </AsideSection>
    </>
  );
}
