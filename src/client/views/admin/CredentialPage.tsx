// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A credential's page under Web access: the crumb is the head, its own
// step the switcher to the other credentials; then a card per setting,
// each drafting and saving apart, nothing before Save: the key file,
// the request it signs, the methods, the projects, and Delete last. The
// aside has the key file's state, the projects and the last change. The
// name is fixed once made.

import { useSignal } from "@preact/signals";
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
  KeyField,
  MethodsField,
  ProjectLines,
  TextField,
} from "./CredentialFields.tsx";
import {
  type CredentialDraft,
  credentialFieldOf,
  deleteLine,
  dirtyOf,
  draftOf,
  HEADER_PLACEHOLDER,
  keyHint,
  keyLine,
  PREFIX_HINT,
  patchBody,
  problemOf,
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
  return (
    <div class="credentials-page">
      {off && (
        <p class="credentials-off" role="status">
          <Icon name="alert" size={16} class="credentials-off-icon" />
          {WEB_OFF_NOTE}
        </p>
      )}
      <KeyCard credential={credential} />
      <RequestCard credential={credential} />
      <MethodsCard credential={credential} />
      <ProjectsCard credential={credential} />
      <DeleteCard credential={credential} />
    </div>
  );
}

// A card's save: its fields over the saved row, so the body carries
// only what this card changed. The row is read through a ref when the
// save runs, so a save of another card in between is not undone.
function useCard<T>(
  credential: CredentialSummary,
  fields: (d: CredentialDraft) => T,
) {
  const drafted = useSignal<T | null>(null);
  const latest = useRef(credential);
  latest.current = credential;
  const form = useRef<HTMLFormElement>(null);
  const merged = (row: CredentialSummary): CredentialDraft => ({
    ...draftOf(row),
    ...(drafted.value ?? {}),
  });
  const save = useSave(async () => {
    const row = latest.current;
    await patchCredential(row.id, patchBody(merged(row), row));
    drafted.value = null;
  }, credentialFieldOf);
  useFocusField(save, form);
  const d = merged(credential);
  return {
    d,
    save,
    form,
    dirty: dirtyOf(d, credential),
    set: (patch: Partial<T>) => {
      drafted.value = { ...fields(d), ...(drafted.value ?? {}), ...patch };
      save.touch();
    },
    discard: () => {
      drafted.value = null;
    },
    submit: (e: Event) => {
      e.preventDefault();
      void save.run(problemOf(d, false));
    },
  };
}

function KeyCard({ credential }: { credential: CredentialSummary }) {
  const card = useCard(credential, (d) => ({ keyName: d.keyName }));
  return (
    <form ref={card.form} onSubmit={card.submit}>
      <Setting
        title="Key"
        line="The http- file whose value goes in the header."
        foot={
          <DraftFoot
            save={card.save}
            dirty={card.dirty}
            onDiscard={card.discard}
          />
        }
      >
        <div class="pair">
          <KeyField
            value={card.d.keyName}
            hint={keyHint(card.d.keyName, credential)}
            save={card.save}
            bare
            onChange={(keyName) => card.set({ keyName })}
          />
        </div>
      </Setting>
    </form>
  );
}

function RequestCard({ credential }: { credential: CredentialSummary }) {
  const card = useCard(credential, (d) => ({
    prefix: d.prefix,
    header: d.header,
    template: d.template,
  }));
  return (
    <form ref={card.form} onSubmit={card.submit}>
      <Setting
        title="Request"
        line="curl sends the header on requests under the prefix."
        foot={
          <DraftFoot
            save={card.save}
            dirty={card.dirty}
            onDiscard={card.discard}
          />
        }
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

function MethodsCard({ credential }: { credential: CredentialSummary }) {
  const card = useCard(credential, (d) => ({ methods: d.methods }));
  return (
    <form ref={card.form} onSubmit={card.submit}>
      <Setting
        title="Methods"
        line="What curl may send under the prefix. Other methods are refused."
        foot={
          <DraftFoot
            save={card.save}
            dirty={card.dirty}
            onDiscard={card.discard}
          />
        }
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

function ProjectsCard({ credential }: { credential: CredentialSummary }) {
  const card = useCard(credential, (d) => ({ projectIds: d.projectIds }));
  const teams = teamsOf(projects.value ?? [], credential);
  return (
    <form ref={card.form} onSubmit={card.submit}>
      <Setting
        title="Projects"
        count={
          teams.length > 0
            ? `${card.d.projectIds.length} of ${teams.length}`
            : undefined
        }
        line="Chats and runs in these projects sign with it."
        list
        foot={
          <DraftFoot
            save={card.save}
            dirty={card.dirty}
            hint={
              card.save.fieldError("projectIds") !== null ? (
                <span class="error">{card.save.fieldError("projectIds")}</span>
              ) : undefined
            }
            onDiscard={card.discard}
          />
        }
      >
        {teams.length === 0 ? (
          <RowsNote>No team projects yet.</RowsNote>
        ) : (
          <ProjectLines
            teams={teams}
            value={card.d.projectIds}
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
