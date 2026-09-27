// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A provider's page under Config, never edited: the crumb is the head,
// its own step the switcher to the other providers; then what it
// connects to, what runs on it (or New agent on it when nothing does),
// and Delete, which waits until nothing does, since the server refuses
// a provider an agent or a decider uses. The aside has its last 30 days.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import type { Params } from "../../app/params.ts";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError } from "../../data/agents.ts";
import { deciders, decidersError } from "../../data/deciders.ts";
import {
  deleteProvider,
  providers,
  providersError,
  providerUsage,
} from "../../data/providers.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { count, longDate, pluralCommas } from "../../lib/format.ts";
import {
  configAgentHref,
  configDeciderHref,
  configProviderHref,
  newAgentHref,
} from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Finder } from "../../ui/Finder.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsAvatar, RowsGo, RowsTitle } from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { keyLine, preset } from "./Agents.model.ts";
import { money } from "./Overview.model.ts";
import "./provider-page.css";

const STEPS = [
  zoneStep("Config"),
  { label: "Providers", href: "/config/providers" },
];

export function ProviderPage({ params }: { params: Params }) {
  const list = providers.value;
  const provider = list?.find((p) => p.name === params.name) ?? null;
  // Used by and Delete name the deciders too, so the page waits for them
  const error =
    providersError.value ?? agentsError.value ?? decidersError.value;
  return (
    <Page
      steps={STEPS}
      title={params.name}
      titleMono
      menu={provider !== null ? <Switcher provider={provider} /> : undefined}
      split
      loading={
        (list === null || agents.value === null || deciders.value === null) &&
        error === null
      }
      empty={
        list !== null && provider === null
          ? "No provider by that name."
          : undefined
      }
      error={error}
    >
      {provider !== null && (
        <Split aside={<Aside provider={provider} />}>
          <div class="provider-page">
            <Connection provider={provider} />
            <UsedBy provider={provider} />
            <DeleteCard provider={provider} />
          </div>
        </Split>
      )}
    </Page>
  );
}

// the crumb's own step: the other providers, by name
function Switcher({ provider }: { provider: ProviderSummary }) {
  const list = byName(providers.value ?? []);
  if (list.length < 2) {
    return <span class="page-crumb-on page-crumb-path">{provider.name}</span>;
  }
  return (
    <Finder
      label="Providers"
      triggerClass="page-pill"
      title={provider.name}
      trigger={
        <>
          <span class="cut">{provider.name}</span>
          <Icon name="chevron" size={14} class="page-pill-chevron" />
        </>
      }
      options={list.map((p) => ({
        value: p.id,
        label: p.name,
        href: configProviderHref(p.name),
      }))}
      value={provider.id}
      mono
      wide
      placeholder="Find a provider"
      none="No provider matches"
    />
  );
}

function Fact({
  label,
  mono,
  bad,
  children,
}: {
  label: string;
  mono?: boolean;
  bad?: boolean;
  children: string;
}) {
  return (
    <>
      <span class="label">{label}</span>
      <span
        class={`provider-page-fact${mono ? " provider-page-fact-mono" : ""}${
          bad ? " error" : ""
        }`}
      >
        {children}
      </span>
    </>
  );
}

function Connection({ provider }: { provider: ProviderSummary }) {
  const missing = provider.keyName !== null && !provider.hasKey;
  return (
    <Setting title="Connection">
      <div class="provider-page-facts">
        <Fact label="Type">{preset(provider.wire).label}</Fact>
        <Fact label="Base URL" mono>
          {provider.baseUrl}
        </Fact>
        <Fact label="Key file" mono={provider.keyName !== null} bad={missing}>
          {provider.keyName === null
            ? "None"
            : keyLine(provider.keyName, provider.hasKey)}
        </Fact>
        <Fact label="Added">{longDate(provider.createdAt)}</Fact>
      </div>
    </Setting>
  );
}

function UsedBy({ provider }: { provider: ProviderSummary }) {
  const onAgents = byName(agents.value ?? []).filter(
    (a) => a.providerId === provider.id,
  );
  const onDeciders = byName(deciders.value ?? []).filter(
    (d) => d.providerId === provider.id,
  );
  const total = onAgents.length + onDeciders.length;
  // nothing runs on it: the card offers the first agent on it
  if (total === 0) {
    return (
      <Setting
        title="Used by"
        line="No agent or decider runs on it yet."
        action={
          <a class="btn btn-small" href={newAgentHref(provider.name)}>
            <Icon name="plus" size={14} />
            New agent
          </a>
        }
      />
    );
  }
  return (
    <Setting list title="Used by" count={String(total)}>
      {onAgents.map((a) => (
        <RowsGo key={a.id} href={configAgentHref(a.name)}>
          <RowsAvatar>
            <AvatarIcon name={a.avatar} size={15} />
          </RowsAvatar>
          <RowsTitle mono name={`@${a.name}`} sub={a.model.id} />
        </RowsGo>
      ))}
      {onDeciders.map((d) => (
        <RowsGo key={d.id} href={configDeciderHref(d.name)}>
          <RowsAvatar>
            <Icon name="check" size={15} />
          </RowsAvatar>
          <RowsTitle mono name={d.name} sub="Decider" />
        </RowsGo>
      ))}
    </Setting>
  );
}

// the words over Delete: what keeps the provider, or that nothing does
export function providerDeleteLine(agentCount: number, deciderCount: number) {
  if (agentCount === 0 && deciderCount === 0) return "Nothing runs on it.";
  const parts = [
    agentCount > 0 ? pluralCommas(agentCount, "agent", "agents") : "",
    deciderCount > 0 ? pluralCommas(deciderCount, "decider", "deciders") : "",
  ].filter((part) => part !== "");
  const one = agentCount + deciderCount === 1;
  return `${parts.join(" and ")} ${one ? "runs" : "run"} on it. Move ${
    one ? "it" : "them"
  } to another provider first.`;
}

function DeleteCard({ provider }: { provider: ProviderSummary }) {
  const asking = useSignal(false);
  const save = useSave(async () => {});
  const agentCount = (agents.value ?? []).filter(
    (a) => a.providerId === provider.id,
  ).length;
  const deciderCount = (deciders.value ?? []).filter(
    (d) => d.providerId === provider.id,
  ).length;
  const inUse = agentCount + deciderCount > 0;
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
      title={`Delete ${provider.name}`}
      line={providerDeleteLine(agentCount, deciderCount)}
      foot={
        <Foot save={save}>
          <div class="provider-page-delete">
            <AskDelete
              save={save}
              asking={asking}
              busy={save.busy || inUse}
              words={`Delete ${provider.name}?`}
              wordsClass="provider-page-ask"
              // the list drops the provider as the call ends, which
              // takes this card away before act answers: the call leaves
              onDelete={() => {
                void save.act("delete", async () => {
                  const from = address();
                  await deleteProvider(provider.id);
                  if (address() === from) navigate("/config/providers");
                });
              }}
            />
          </div>
        </Foot>
      }
    />
  );
}

// every agent's turns and runs on the provider, as an agent's page has
// its own
function Aside({ provider }: { provider: ProviderSummary }) {
  const known =
    providerUsage.value?.providerId === provider.id
      ? providerUsage.value
      : null;
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
          <AsideLine label="Turns">{count(usage.sends)}</AsideLine>
          <AsideLine label="Tokens">{count(usage.tokens)}</AsideLine>
          <AsideLine label="Cost">
            {usage.cost === null ? "not priced" : money(usage.cost)}
          </AsideLine>
        </>
      )}
    </AsideSection>
  );
}
