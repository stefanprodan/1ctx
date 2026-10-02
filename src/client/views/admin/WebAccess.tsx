// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
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
import { CREDENTIALS_HREF } from "../../lib/hrefs.ts";
import { at, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Page, PageNew } from "../../ui/Page.tsx";
import { RowsLine, RowsMeta, RowsRadio, RowsTitle } from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Setting, SettingForm } from "../../ui/Setting.tsx";
import { AsideLine, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { KeyFilesSection, UsageSection } from "./AdminAside.tsx";
import { CredentialList } from "./CredentialList.tsx";
import { keyReader } from "./Credentials.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
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
  searchKeyLine,
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
  const error =
    toolsError.value ?? (tab === "credentials" ? credentialsError.value : null);
  // an empty list says no count
  const listed = credentials.value?.length || undefined;
  return (
    <Page
      steps={[zoneStep("Config")]}
      title="Web access"
      split
      actions={
        tab === "credentials" ? (
          <PageNew href={`${CREDENTIALS_HREF}?new`} label="New credential" />
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
            {/* hidden, not unmounted, so a draft outlives a look */}
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

// null until a pick, so a load that lands late shows through
function Access({ state }: { state: ToolsResponse }) {
  const access = state.access;
  const drafted = useSignal<WebAccessMode | null>(null);
  const text = useSignal<string | null>(null);
  const latest = useLatest(access);
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
  const mode = drafted.value ?? access.mode;
  const typed = text.value ?? domainsText(access.domains);
  const invalid = save.fieldError("domains") !== null;
  return (
    <SettingForm
      save={save}
      check={() => {
        const got = accessBody(mode, typed);
        return "error" in got ? at("domains", got.error) : null;
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
              // back on a saved mode, the typed hosts go
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
    </SettingForm>
  );
}

function Search({ state }: { state: ToolsResponse }) {
  const search = state.search;
  const drafted = useSignal<{ provider: SearchProvider | null } | null>(null);
  const latest = useLatest(search);
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
    <SettingForm save={save}>
      <Setting
        title="Search"
        line={searchLine({ ...search, provider }, state.access.mode)}
        list
        foot={
          <DraftFoot
            save={save}
            dirty={provider !== search.provider}
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
            <RowsMeta>{searchKeyLine(p, search.keys[p])}</RowsMeta>
          </RowsLine>
        ))}
      </Setting>
    </SettingForm>
  );
}

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
  const list = credentials.value;
  return (
    <>
      <UsageSection value={webUsage.value()}>
        {(usage) => (
          <>
            <AsideLine label="Fetches">{count(usage.fetches)}</AsideLine>
            <AsideLine label="Searches">{count(usage.searches)}</AsideLine>
            <AsideLine label="Failed">{count(usage.failed)}</AsideLine>
          </>
        )}
      </UsageSection>
      {tab === "credentials" && list !== null && (
        <KeyFilesSection
          files={credentialKeys.value.map((k) => k.name)}
          reader={keyReader(list, credentialKeys.value)}
        />
      )}
    </>
  );
}
