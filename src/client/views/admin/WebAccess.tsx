// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Config › Web access, in two tabs. General: who agents may reach, the
// search provider, how much one turn may fetch and search, and the two
// tools it offers, each a card that drafts and saves apart. Credentials:
// the list of what bash's curl signs with, each a link to its page, New
// credential in the head and `?new` its form. The aside has the last 30
// days, and on Credentials the http- key files. Nothing saves before
// Save, the mode and the provider included. A change applies to the
// next turn.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import type { ToolsResponse } from "../../../shared/api/tools.ts";
import type { WebAccessMode } from "../../../shared/web.ts";
import {
  SEARCH_PROVIDERS,
  type SearchProvider,
} from "../../../shared/words.ts";
import { path, query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  credentialKeys,
  credentials,
  credentialsError,
} from "../../data/credentials.ts";
import {
  limits,
  patchTool,
  tools,
  toolsError,
  webUsage,
} from "../../data/tools.ts";
import { count, tokensText } from "../../lib/format.ts";
import { CREDENTIALS_HREF, configCredentialHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsLine, RowsMeta, RowsRadio, RowsTitle } from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { CredentialList } from "./CredentialList.tsx";
import { keyUsers } from "./Credentials.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { LimitsSetting } from "./LimitsSetting.tsx";
import { NewCredential } from "./NewCredential.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { totalTokens } from "./Tools.model.ts";
import {
  ACCESS_MODES,
  ACCESS_WORDS,
  accessBody,
  accessDirty,
  boxRows,
  DOMAINS_HINT,
  DOMAINS_PLACEHOLDER,
  domainsCount,
  domainsFieldOf,
  domainsText,
  keyLine,
  searchDirty,
  searchLine,
  WEB_LIMITS,
  WEB_TABS,
  webTab,
} from "./WebAccess.model.ts";
import "./web-access.css";

export function WebAccess() {
  const tab = webTab(path.value);
  if (tab === "credentials" && new URLSearchParams(query.value).has("new")) {
    return <NewCredential />;
  }
  return <Tabbed tab={tab} />;
}

function Tabbed({ tab }: { tab: "general" | "credentials" }) {
  const state = tools.value;
  const rows = limits.value;
  // the Credentials tab fails with its list too
  const error =
    toolsError.value ?? (tab === "credentials" ? credentialsError.value : null);
  const listed = credentials.value?.length;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Web access"
      split
      actions={
        tab === "credentials" ? (
          <a class="btn btn-small" href={`${CREDENTIALS_HREF}?new`}>
            <Icon name="plus" size={14} />
            New credential
          </a>
        ) : undefined
      }
      loading={(state === null || rows === null) && error === null}
      error={error}
    >
      {state && rows && (
        <Split aside={<Aside tab={tab} />}>
          <div class="web-access">
            <Tabs
              tabs={WEB_TABS.map(({ tab, label, href }) => ({
                label,
                href,
                count: tab === "credentials" ? listed : undefined,
              }))}
              active={WEB_TABS.find((t) => t.tab === tab)!.href}
            />
            {/* hidden, not unmounted, so a draft outlives a look at
                Credentials */}
            <div
              class={`web-access-cards${
                tab === "general" ? "" : " web-access-away"
              }`}
            >
              <Access state={state} />
              <Search state={state} />
              <LimitsSetting
                rows={rows}
                names={WEB_LIMITS}
                line="How much agents may fetch and search."
              />
              <Tools state={state} />
            </div>
            {tab === "credentials" && <CredentialList />}
          </div>
        </Split>
      )}
    </Page>
  );
}

// the mode in the head, the line under the title saying what the
// drafted mode lets agents do; Listed domains opens the box. The drafts
// are null until a pick or a keystroke, so the card shows what was
// saved, a load that lands after the first draw included
function Access({ state }: { state: ToolsResponse }) {
  const access = state.access;
  const drafted = useSignal<WebAccessMode | null>(null);
  const text = useSignal<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const latest = useRef(access);
  latest.current = access;
  const save = useSave(async () => {
    const saved = latest.current;
    const got = accessBody(
      drafted.value ?? saved.mode,
      text.value ?? domainsText(saved.domains),
    );
    if ("error" in got) return;
    await patchTool("web", got.body);
    drafted.value = null;
    text.value = null;
  }, domainsFieldOf);
  useFocusField(save, form);
  const mode = drafted.value ?? access.mode;
  const typed = text.value ?? domainsText(access.domains);
  const invalid = save.fieldError("domains") !== null;
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        const got = accessBody(mode, typed);
        void save.run("error" in got ? at("domains", got.error) : null);
      }}
    >
      <Setting
        title="Access"
        count={mode === "listed" ? domainsCount(typed) : undefined}
        line={ACCESS_WORDS[mode]}
        action={
          <Seg
            label="Web access"
            name="mode"
            value={mode}
            options={ACCESS_MODES.map((m) => ({
              ...m,
              disabled: save.busy,
            }))}
            onPick={(next) => {
              drafted.value = next;
              // back on a saved mode that hides the box, what was typed
              // in it goes, so Listed shows the saved list again
              if (next === access.mode && next !== "listed") {
                text.value = null;
              }
              save.touch();
            }}
          />
        }
        foot={
          <DraftFoot
            save={save}
            dirty={accessDirty(mode, typed, access)}
            onDiscard={() => {
              drafted.value = null;
              text.value = null;
            }}
          />
        }
      >
        {mode === "listed" && (
          <label class="field">
            <textarea
              name="domains"
              class="web-access-domains"
              aria-label="Allowed hosts"
              rows={boxRows(typed)}
              spellcheck={false}
              autocomplete="off"
              placeholder={DOMAINS_PLACEHOLDER}
              value={typed}
              disabled={save.busy}
              aria-invalid={invalid || undefined}
              onInput={(event) => {
                text.value = (event.currentTarget as HTMLTextAreaElement).value;
                save.touch();
              }}
            />
            {invalid ? (
              <FieldError save={save} field="domains" />
            ) : (
              <span class="hint">{DOMAINS_HINT}</span>
            )}
          </label>
        )}
      </Setting>
    </form>
  );
}

// None first, then a row per provider with whether its key file is
// there; the line follows the drafted pick
function Search({ state }: { state: ToolsResponse }) {
  const search = state.search;
  const drafted = useSignal<{ provider: SearchProvider | null } | null>(null);
  const latest = useRef(search);
  latest.current = search;
  const save = useSave(async () => {
    const provider = (drafted.value ?? latest.current).provider;
    await patchTool("websearch", { provider });
    drafted.value = null;
  });
  const provider = (drafted.value ?? search).provider;
  const pick = (next: SearchProvider | null) => {
    drafted.value = { provider: next };
    save.touch();
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <Setting
        title="Search"
        line={searchLine({ ...search, provider }, state.access.mode)}
        list
        foot={
          <DraftFoot
            save={save}
            dirty={searchDirty(provider, search)}
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
      >
        <RowsLine as="label" flush>
          <RowsRadio
            name="provider"
            value="none"
            checked={provider === null}
            disabled={save.busy}
            onChange={() => pick(null)}
          />
          <RowsTitle name="None" mono />
        </RowsLine>
        {SEARCH_PROVIDERS.map((p) => (
          <RowsLine key={p} as="label" flush>
            <RowsRadio
              name="provider"
              value={p}
              checked={provider === p}
              disabled={save.busy}
              onChange={() => pick(p)}
            />
            <RowsTitle name={p} mono />
            <RowsMeta>{keyLine(p, search.keys[p])}</RowsMeta>
          </RowsLine>
        ))}
      </Setting>
    </form>
  );
}

// webfetch and websearch as the model gets them, one open at a time
function Tools({ state }: { state: ToolsResponse }) {
  const open = useSignal<string | null>(null);
  const rows = state.builtin.filter(
    (tool) => tool.name === "webfetch" || tool.name === "websearch",
  );
  return (
    <Setting title="Tools" count={tokensText(totalTokens(rows))} list>
      {rows.map((tool) => (
        <ToolRow
          key={tool.name}
          tool={tool}
          open={open.value === tool.name}
          onToggle={() => {
            open.value = open.value === tool.name ? null : tool.name;
          }}
        />
      ))}
    </Setting>
  );
}

function Aside({ tab }: { tab: "general" | "credentials" }) {
  const known = webUsage.value;
  const usage = known?.usage ?? null;
  return (
    <>
      <AsideSection label="Last 30 days">
        {known === null ? (
          <p class="split-empty">Loading</p>
        ) : usage === null ? (
          <p class="split-empty">Did not load.</p>
        ) : (
          <>
            <AsideLine label="Fetches">{count(usage.fetches)}</AsideLine>
            <AsideLine label="Searches">{count(usage.searches)}</AsideLine>
            <AsideLine label="Failed">{count(usage.failed)}</AsideLine>
          </>
        )}
      </AsideSection>
      {tab === "credentials" && <KeyFiles />}
    </>
  );
}

// the http- files in the secrets directory, each with the credential
// that reads it, or how many share it
function KeyFiles() {
  const list = credentials.value;
  if (list === null) return null;
  const files = credentialKeys.value
    .map((k) => k.name)
    .sort((a, b) => a.localeCompare(b));
  return (
    <AsideSection label="Key files">
      {files.length === 0 ? (
        <p class="split-empty">None in the secrets directory.</p>
      ) : (
        files.map((file) => {
          const users = keyUsers(file, list);
          return (
            <AsideLine
              key={file}
              label={`${file}.key`}
              cut
              href={
                users.name !== null
                  ? configCredentialHref(users.name)
                  : undefined
              }
              quiet={users.count === 0}
            >
              {users.label}
            </AsideLine>
          );
        })
      )}
    </AsideSection>
  );
}
