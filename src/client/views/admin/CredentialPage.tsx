// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import type {
  CredentialSummary,
  HttpMethod,
} from "../../../shared/contracts/credential.ts";
import type { Params } from "../../app/params.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  credentials,
  credentialsError,
  deleteCredential,
  patchCredential,
} from "../../data/credentials.ts";
import { projects, projectsError } from "../../data/projects.ts";
import { tools } from "../../data/tools.ts";
import { ago, pluralCommas } from "../../lib/format.ts";
import { CREDENTIALS_HREF, configCredentialHref } from "../../lib/hrefs.ts";
import { useNow } from "../../lib/now.ts";
import { Page, PageSwitcher } from "../../ui/Page.tsx";
import { RowsNote } from "../../ui/Rows.tsx";
import {
  Setting,
  SettingAlert,
  SettingDelete,
  SettingForm,
  SettingStack,
} from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { KeyField, MethodsField, RequestFields } from "./CredentialFields.tsx";
import {
  type CredentialDraft,
  type CredentialField,
  cardBody,
  cardFieldOf,
  cardProblem,
  deleteLine,
  draftOf,
  keyHint,
  keyLine,
  teamsOf,
  WEB_OFF_NOTE,
} from "./Credentials.model.ts";
import { type DraftCard, useDraftCard } from "./DraftCard.tsx";
import { holding } from "./drafts.ts";
import { AddProject, ProjectRows } from "./ProjectPicks.tsx";
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
        credential !== null ? (
          <PageSwitcher
            label="Credentials"
            current={credential.id}
            name={credential.name}
            items={(list ?? []).map((c) => ({
              id: c.id,
              label: c.name,
              href: configCredentialHref(c.name),
            }))}
            placeholder="Find a credential"
            none="No credential matches"
          />
        ) : undefined
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

function Body({ credential }: { credential: CredentialSummary }) {
  const saving = useSignal(false);
  return (
    <SettingStack>
      {tools.value?.access.mode === "off" && (
        <SettingAlert>{WEB_OFF_NOTE}</SettingAlert>
      )}
      <KeyCard credential={credential} saving={saving} />
      <RequestCard credential={credential} saving={saving} />
      <MethodsCard credential={credential} saving={saving} />
      <ProjectsCard credential={credential} saving={saving} />
      <SettingDelete
        title={`Delete ${credential.name}`}
        line={deleteLine(credential)}
        ask={`Delete ${credential.name}?`}
        // a card's save in flight could put the row back
        off={saving.value}
        // and a save during the delete would 404
        onDelete={() => holding(saving, () => deleteCredential(credential.id))}
        leaveTo={CREDENTIALS_HREF}
      />
    </SettingStack>
  );
}

type CardProps = {
  credential: CredentialSummary;
  saving: Signal<boolean>;
};

function useCard(
  { credential, saving }: CardProps,
  keys: readonly CredentialField[],
): DraftCard<CredentialDraft> {
  return useDraftCard({
    row: credential,
    saving,
    of: draftOf,
    dirty: (d, row) => Object.keys(cardBody(d, row, keys)).length > 0,
    send: (d, row) => patchCredential(row.id, cardBody(d, row, keys)),
    fieldOf: cardFieldOf(keys),
  });
}

function CardForm({
  card,
  keys,
  children,
}: {
  card: DraftCard<CredentialDraft>;
  keys: readonly CredentialField[];
  children: ComponentChildren;
}) {
  return (
    <SettingForm save={card.save} check={() => cardProblem(card.d, keys)}>
      {children}
    </SettingForm>
  );
}

const KEY: readonly CredentialField[] = ["keyName"];
const REQUEST: readonly CredentialField[] = ["prefix", "header", "template"];
const METHODS: readonly CredentialField[] = ["methods"];
const PROJECTS: readonly CredentialField[] = ["projectIds"];

function KeyCard(props: CardProps) {
  const card = useCard(props, KEY);
  return (
    <CardForm card={card} keys={KEY}>
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
    </CardForm>
  );
}

function RequestCard(props: CardProps) {
  const card = useCard(props, REQUEST);
  return (
    <CardForm card={card} keys={REQUEST}>
      <Setting
        title="Request"
        line="curl adds the header to requests under the prefix."
        foot={card.foot()}
      >
        <div class="pair">
          <RequestFields d={card.d} save={card.save} set={card.set} />
        </div>
      </Setting>
    </CardForm>
  );
}

function MethodsCard(props: CardProps) {
  const card = useCard(props, METHODS);
  return (
    <CardForm card={card} keys={METHODS}>
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
    </CardForm>
  );
}

function ProjectsCard(props: CardProps) {
  const card = useCard(props, PROJECTS);
  const loaded = projects.value !== null;
  const teams = teamsOf(projects.value ?? [], props.credential);
  const ids = card.d.projectIds;
  const refused = card.save.fieldError("projectIds");
  return (
    <CardForm card={card} keys={PROJECTS}>
      <Setting
        title="Projects"
        count={String(ids.length)}
        line="Chats and runs in these projects can use it."
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
        foot={card.foot({
          hint:
            refused !== null ? <span class="error">{refused}</span> : undefined,
        })}
      >
        {!loaded ? (
          <RowsNote>
            {projectsError.value !== null ? "Did not load." : "Loading"}
          </RowsNote>
        ) : ids.length === 0 ? (
          <RowsNote>No projects yet.</RowsNote>
        ) : (
          <ProjectRows
            teams={teams}
            value={ids}
            save={card.save}
            onChange={(projectIds) => card.set({ projectIds })}
          />
        )}
      </Setting>
    </CardForm>
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
