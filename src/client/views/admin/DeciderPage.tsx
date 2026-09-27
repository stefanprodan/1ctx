// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A decider's page under Config, as an agent's: the crumb is the head,
// its own step the switcher to the other deciders; then the name with
// the default mark, the model, Check, which asks the saved decider one
// yes/no, and Delete, each its own card and form. The aside has its
// last 30 days and the decisions that ask it.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { DeciderSummary } from "../../../shared/contracts/decider.ts";
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
import { decisions } from "../../data/decisions.ts";
import { providersError } from "../../data/providers.ts";
import { count, says } from "../../lib/format.ts";
import { configDeciderHref, configDecisionHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { nameProblem, shapedInput } from "../../lib/names.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Finder } from "../../ui/Finder.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsCheck } from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
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
import { money } from "./Overview.model.ts";
import "./decider-page.css";

const STEPS = [
  zoneStep("Config"),
  { label: "Deciders", href: "/config/deciders" },
];

export function DeciderPage({ params }: { params: Params }) {
  const list = deciders.value;
  // the decider on screen by its id too: a rename changes the list a
  // moment before the address follows
  const shown = useRef<{ id: string; name: string } | null>(null);
  const held = shown.current?.name === params.name ? shown.current : null;
  const decider =
    list?.find((d) => d.name === params.name) ??
    list?.find((d) => d.id === held?.id) ??
    null;
  const leaving = decider === null && held !== null;
  if (decider !== null && decider.name === params.name) {
    shown.current = { id: decider.id, name: decider.name };
  }
  // one set of drafts per decider: a pick of another starts afresh
  const drafts = useRef<DeciderDrafts | null>(null);
  const row = useRef<DeciderSummary | null>(null);
  if (decider !== null && drafts.current?.deciderId !== decider.id) {
    drafts.current = DeciderDrafts.of(decider);
  } else if (
    decider !== null &&
    row.current !== null &&
    row.current !== decider
  ) {
    drafts.current?.follow(row.current, decider);
  }
  row.current = decider;
  const error = decidersError.value ?? providersError.value;
  return (
    <Page
      steps={STEPS}
      title={params.name}
      titleMono
      menu={decider !== null ? <Switcher decider={decider} /> : undefined}
      split
      loading={list === null && error === null}
      empty={
        list !== null && decider === null && !leaving
          ? "No decider by that name."
          : undefined
      }
      error={error}
    >
      {decider !== null && drafts.current !== null && (
        <Split aside={<Aside decider={decider} />}>
          <div class="decider-page" key={decider.id}>
            <Identity decider={decider} drafts={drafts.current} />
            <Model decider={decider} drafts={drafts.current} />
            <Check decider={decider} />
            <DeleteCard decider={decider} />
          </div>
        </Split>
      )}
    </Page>
  );
}

function Switcher({ decider }: { decider: DeciderSummary }) {
  const list = byName(deciders.value ?? []);
  if (list.length < 2) {
    return <span class="page-crumb-on page-crumb-path">{decider.name}</span>;
  }
  return (
    <Finder
      label="Deciders"
      triggerClass="page-pill"
      title={decider.name}
      trigger={
        <>
          <span class="cut">{decider.name}</span>
          <Icon name="chevron" size={14} class="page-pill-chevron" />
        </>
      }
      options={list.map((d) => ({
        value: d.id,
        label: d.name,
        href: configDeciderHref(d.name),
      }))}
      value={decider.id}
      mono
      wide
      placeholder="Find a decider"
      none="No decider matches"
    />
  );
}

// what a decider's save sends: every field, the mark only when flipped
// so a save never moves a mark set since
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
  // the save is made once, so it reads the latest row when it runs
  const latest = useRef(decider);
  latest.current = decider;
  const save = useSave(async () => {
    const was = latest.current;
    const saved = await updateDecider(
      was.id,
      body(was, { name: d.name.value.trim(), default: d.isDefault.value }),
    );
    d.resetGeneral(saved);
    if (saved.name !== was.name) {
      navigate(configDeciderHref(saved.name), true);
    }
  }, deciderFieldOf);
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  const name = d.name.value.trim();
  const taken = (deciders.value ?? []).some(
    (x) => x.name === name && x.id !== decider.id,
  );
  // the oldest, while it is the default, keeps the mark: No hands it to
  // the oldest
  const kept = decider.default && deciders.value?.[0]?.id === decider.id;
  const busy = save.busy;
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(at("name", nameProblem(d.name.value)));
      }}
    >
      <Setting
        title="Identity"
        foot={
          <DraftFoot
            save={save}
            dirty={d.generalDirty(decider)}
            blocked={taken || name === ""}
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
    </form>
  );
}

function Model({
  decider,
  drafts: d,
}: {
  decider: DeciderSummary;
  drafts: DeciderDrafts;
}) {
  const latest = useRef(decider);
  latest.current = decider;
  const save = useSave(async () => {
    const was = latest.current;
    const saved = await updateDecider(
      was.id,
      body(was, {
        providerId: d.providerId.value,
        model: d.model.value?.id ?? "",
      }),
    );
    d.resetModel(saved);
  }, deciderFieldOf);
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(
          at("model", d.model.value === null ? "Pick a model" : null),
        );
      }}
    >
      <Setting
        title="Model"
        foot={
          <DraftFoot
            save={save}
            dirty={d.modelDirty(decider)}
            blocked={d.model.value === null || d.changing.value}
            open={d.changing.value}
            onDiscard={() => d.resetModel(decider)}
          />
        }
      >
        <DeciderModelFields drafts={d} save={save} currentId={decider.model} />
      </Setting>
    </form>
  );
}

// the saved decider answers one fixed yes/no, whatever a draft holds
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

function DeleteCard({ decider }: { decider: DeciderSummary }) {
  const asking = useSignal(false);
  const save = useSave(async () => {});
  const asks = askedBy(decider, decisions.value ?? []).length;
  // Escape takes the ask back
  useEffect(() => {
    if (!asking.value) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") asking.value = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking.value]);
  return (
    <Setting
      danger
      title={`Delete ${decider.name}`}
      line={deciderDeleteLine(decider, deciders.value ?? [], asks)}
      foot={
        <Foot save={save}>
          <div class="decider-page-foot">
            <AskDelete
              save={save}
              asking={asking}
              busy={save.busy}
              words={`Delete ${decider.name}?`}
              wordsClass="decider-page-ask"
              // the list drops the decider as the call ends, which takes
              // this card away before act answers: the call leaves
              onDelete={() => {
                void save.act("delete", async () => {
                  await deleteDecider(decider.id);
                  navigate("/config/deciders");
                });
              }}
            />
          </div>
        </Foot>
      }
    />
  );
}

function Aside({ decider }: { decider: DeciderSummary }) {
  const known =
    deciderUsage.value?.of === decider.id ? deciderUsage.value : null;
  const usage = known?.usage ?? null;
  const asks = askedBy(decider, decisions.value ?? []);
  return (
    <>
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
