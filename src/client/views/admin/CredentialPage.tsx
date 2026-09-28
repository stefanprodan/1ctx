// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A credential's page under Web access: the crumb is the head, its own
// step the switcher to the other credentials; then a card per setting,
// each drafting and saving apart, nothing before Save: the key file,
// the request it signs, the methods, the projects, and Delete last. The
// aside has the key file's state, the projects and the last change. The
// name is fixed once made.

import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type {
  CredentialSummary,
  HttpMethod,
} from "../../../shared/contracts/credential.ts";
import type { Params } from "../../app/params.ts";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  credentials,
  credentialsError,
  deleteCredential,
  patchCredential,
} from "../../data/credentials.ts";
import { projects } from "../../data/projects.ts";
import { tools } from "../../data/tools.ts";
import { ago, pluralCommas } from "../../lib/format.ts";
import { CREDENTIALS_HREF, configCredentialHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { useFocusField, useSave } from "../../lib/save.ts";
import { Finder } from "../../ui/Finder.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsNote } from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import {
  AddProject,
  KeyField,
  MethodsField,
  ProjectRows,
  TextField,
} from "./CredentialFields.tsx";
import {
  type CredentialDraft,
  type CredentialField,
  cardBody,
  cardFieldOf,
  cardProblem,
  deleteLine,
  draftOf,
  HEADER_PLACEHOLDER,
  keyHint,
  keyLine,
  PREFIX_HINT,
  TEMPLATE_HINT,
  TEMPLATE_PLACEHOLDER,
  teamsOf,
  WEB_OFF_NOTE,
} from "./Credentials.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import "./credentials.css";

const STEPS = [
  zoneStep("Config"),
  { label: "Web access", href: CREDENTIALS_HREF },
];

export function CredentialPage({ params }: { params: Params }) {
  const list = credentials.value;
  const credential = list?.find((c) => c.name === params.name) ?? null;
  const error = credentialsError.value;
  return (
    <Page
      steps={STEPS}
      title={params.name}
      titleMono
      menu={
        credential !== null ? <Switcher credential={credential} /> : undefined
      }
      split
      loading={list === null && error === null}
      empty={
        list !== null && credential === null
          ? "No credential by that name."
          : undefined
      }
      error={error}
    >
      {credential !== null && (
        <Split aside={<Aside credential={credential} />}>
          <Body key={credential.id} credential={credential} />
        </Split>
      )}
    </Page>
  );
}

// the crumb's own step: the other credentials by name
function Switcher({ credential }: { credential: CredentialSummary }) {
  const list = credentials.value ?? [];
  if (list.length < 2) {
    return <span class="page-crumb-on page-crumb-path">{credential.name}</span>;
  }
  return (
    <Finder
      label="Credentials"
      triggerClass="page-pill"
      title={credential.name}
      trigger={
        <>
          <span class="cut">{credential.name}</span>
          <Icon name="chevron" size={14} class="page-pill-chevron" />
        </>
      }
      options={list.map((c) => ({
        value: c.id,
        label: c.name,
        href: configCredentialHref(c.name),
      }))}
      value={credential.id}
      mono
      wide
      placeholder="Find a credential"
      none="No credential matches"
    />
  );
}

function Body({ credential }: { credential: CredentialSummary }) {
  const off = tools.value?.access.mode === "off";
  // one card saves at a time, so a slower answer never puts back what
  // a later save changed
  const saving = useSignal(false);
  return (
    <div class="credentials-page">
      {off && (
        <p class="credentials-off" role="status">
          <Icon name="alert" size={16} class="credentials-off-icon" />
          {WEB_OFF_NOTE}
        </p>
      )}
      <KeyCard credential={credential} saving={saving} />
      <RequestCard credential={credential} saving={saving} />
      <MethodsCard credential={credential} saving={saving} />
      <ProjectsCard credential={credential} saving={saving} />
      <DeleteCard credential={credential} />
    </div>
  );
}

type CardProps = {
  credential: CredentialSummary;
  saving: Signal<boolean>;
};

// A card's draft over the saved row: null until edited, then the card's
// own fields. Its body and its dirt are what it changed of those alone,
// and a refusal naming another card's field is its notice. The row is
// read through a ref when the save runs, so a save of another card in
// between is not undone.
function useCard(
  { credential, saving }: CardProps,
  keys: readonly CredentialField[],
) {
  const drafted = useSignal<Partial<CredentialDraft> | null>(null);
  const latest = useRef(credential);
  latest.current = credential;
  const form = useRef<HTMLFormElement>(null);
  const merged = (row: CredentialSummary): CredentialDraft => ({
    ...draftOf(row),
    ...(drafted.value ?? {}),
  });
  const save = useSave(async () => {
    const row = latest.current;
    saving.value = true;
    try {
      await patchCredential(row.id, cardBody(merged(row), row, keys));
    } finally {
      saving.value = false;
    }
    drafted.value = null;
  }, cardFieldOf(keys));
  useFocusField(save, form);
  const d = merged(credential);
  const dirty = Object.keys(cardBody(d, credential, keys)).length > 0;
  return {
    d,
    save,
    form,
    foot: (hint?: ComponentChildren) => (
      <DraftFoot
        save={save}
        dirty={dirty}
        locked={saving.value && !save.busy}
        hint={hint}
        onDiscard={() => {
          drafted.value = null;
        }}
      />
    ),
    set: (patch: Partial<CredentialDraft>) => {
      drafted.value = { ...(drafted.value ?? {}), ...patch };
      save.touch();
    },
    submit: (e: Event) => {
      e.preventDefault();
      void save.run(cardProblem(d, keys));
    },
  };
}

function KeyCard(props: CardProps) {
  const card = useCard(props, ["keyName"]);
  return (
    <form ref={card.form} onSubmit={card.submit}>
      <Setting
        title="Key"
        line="The http- file whose value goes in the header."
        foot={card.foot()}
      >
        <div class="pair">
          <KeyField
            value={card.d.keyName}
            hint={keyHint(card.d.keyName, props.credential)}
            save={card.save}
            bare
            onChange={(keyName) => card.set({ keyName })}
          />
        </div>
      </Setting>
    </form>
  );
}

function RequestCard(props: CardProps) {
  const card = useCard(props, ["prefix", "header", "template"]);
  return (
    <form ref={card.form} onSubmit={card.submit}>
      <Setting
        title="Request"
        line="curl adds the header to requests under the prefix."
        foot={card.foot()}
      >
        <div class="pair">
          <TextField
            label="URL prefix"
            name="prefix"
            value={card.d.prefix}
            placeholder="https://api.github.com/"
            hint={PREFIX_HINT}
            required
            wide
            save={card.save}
            onInput={(prefix) => card.set({ prefix })}
          />
          <TextField
            label="Header"
            name="header"
            value={card.d.header}
            placeholder={HEADER_PLACEHOLDER}
            required
            save={card.save}
            onInput={(header) => card.set({ header })}
          />
          <TextField
            label="Value"
            name="template"
            value={card.d.template}
            placeholder={TEMPLATE_PLACEHOLDER}
            hint={TEMPLATE_HINT}
            required
            save={card.save}
            onInput={(template) => card.set({ template })}
          />
        </div>
      </Setting>
    </form>
  );
}

function MethodsCard(props: CardProps) {
  const card = useCard(props, ["methods"]);
  return (
    <form ref={card.form} onSubmit={card.submit}>
      <Setting
        title="Methods"
        line="What curl may use under the prefix. Other methods are refused."
        foot={card.foot()}
      >
        <MethodsField
          value={card.d.methods}
          save={card.save}
          onChange={(methods: HttpMethod[]) => card.set({ methods })}
        />
      </Setting>
    </form>
  );
}

// the projects it is bound to, each with a remove, and Add project over
// the team projects it is not
function ProjectsCard(props: CardProps) {
  const card = useCard(props, ["projectIds"]);
  const loaded = projects.value !== null;
  const teams = teamsOf(projects.value ?? [], props.credential);
  const ids = card.d.projectIds;
  const refused = card.save.fieldError("projectIds");
  return (
    <form ref={card.form} onSubmit={card.submit}>
      <Setting
        title="Projects"
        count={String(ids.length)}
        line="Chats and runs in these projects sign with it."
        list
        action={
          loaded && (
            <AddProject
              teams={teams}
              value={ids}
              disabled={card.save.busy}
              onChange={(projectIds) => card.set({ projectIds })}
            />
          )
        }
        foot={card.foot(
          refused !== null ? <span class="error">{refused}</span> : undefined,
        )}
      >
        {!loaded ? (
          <RowsNote>Loading</RowsNote>
        ) : ids.length === 0 ? (
          <RowsNote>No projects. It signs nothing until one is added.</RowsNote>
        ) : (
          <ProjectRows
            teams={teams}
            value={ids}
            save={card.save}
            onChange={(projectIds) => card.set({ projectIds })}
          />
        )}
      </Setting>
    </form>
  );
}

function DeleteCard({ credential }: { credential: CredentialSummary }) {
  const asking = useSignal(false);
  const save = useSave(async () => {});
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
      title={`Delete ${credential.name}`}
      line={deleteLine(credential)}
      foot={
        <Foot save={save}>
          <div class="credentials-delete">
            <AskDelete
              save={save}
              asking={asking}
              busy={save.busy}
              words={`Delete ${credential.name}?`}
              wordsClass="credentials-ask"
              // the list drops the row as the call ends, which takes
              // this page away before act answers: the call leaves
              onDelete={() => {
                void save.act("delete", async () => {
                  const from = address();
                  await deleteCredential(credential.id);
                  if (address() === from) navigate(CREDENTIALS_HREF);
                });
              }}
            />
          </div>
        </Foot>
      }
    />
  );
}

function Aside({ credential }: { credential: CredentialSummary }) {
  const now = useNow(60_000);
  const key = keyLine(credential.keyName, credential.key);
  const n = credential.projects.length;
  return (
    <AsideSection label="Credential">
      <AsideLine label="Key file" cut>
        <span class={key.bad ? "error" : undefined}>{key.text}</span>
      </AsideLine>
      <AsideLine label="Projects" quiet={n === 0}>
        {n === 0 ? "none" : pluralCommas(n, "project", "projects")}
      </AsideLine>
      <AsideLine label="Changed">{ago(credential.updatedAt, now)}</AsideLine>
    </AsideSection>
  );
}
