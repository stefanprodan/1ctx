// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import { AgentLinks } from "../../agents/AgentLinks.tsx";
import type { Params } from "../../app/params.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, agentsError } from "../../data/agents.ts";
import { deciders, decidersError } from "../../data/deciders.ts";
import {
  deleteProvider,
  providers,
  providersError,
  providerUsage,
} from "../../data/providers.ts";
import { longDate } from "../../lib/format.ts";
import {
  configAgentHref,
  configDeciderHref,
  configProviderHref,
  newAgentHref,
} from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { byName } from "../../lib/search.ts";
import { Page, PageNew, PageSwitcher } from "../../ui/Page.tsx";
import { RowsAvatar, RowsGo, RowsTitle } from "../../ui/Rows.tsx";
import {
  Setting,
  SettingDelete,
  SettingFact,
  SettingFacts,
  SettingStack,
} from "../../ui/Setting.tsx";
import { Split } from "../../ui/Split.tsx";
import { SpendLines, UsageSection } from "./AdminAside.tsx";
import { keyLine, preset } from "./Agents.model.ts";
import { providerDeleteLine } from "./Providers.model.ts";

const LIST = "/admin/config/providers";
const STEPS = [zoneStep("Config"), { label: "Providers", href: LIST }];

export function ProviderPage({ params }: { params: Params }) {
  const list = providers.value;
  const provider = list?.find((p) => p.name === params.name) ?? null;
  const error =
    providersError.value ?? agentsError.value ?? decidersError.value;
  return (
    <Page
      steps={STEPS}
      title={params.name}
      titleMono
      menu={
        provider !== null ? (
          <PageSwitcher
            label="Providers"
            current={provider.id}
            name={provider.name}
            items={byName(list ?? []).map((p) => ({
              id: p.id,
              label: p.name,
              href: configProviderHref(p.name),
            }))}
            placeholder="Find a provider"
            none="No provider matches"
          />
        ) : undefined
      }
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
        <Split
          aside={
            <UsageSection value={providerUsage.valueFor(provider.id)}>
              {(usage) => (
                <SpendLines
                  label="Turns"
                  count={usage.sends}
                  tokens={usage.tokens}
                  cost={usage.cost}
                />
              )}
            </UsageSection>
          }
        >
          <SettingStack>
            <Connection provider={provider} />
            <UsedBy provider={provider} />
            <DeleteCard provider={provider} />
          </SettingStack>
        </Split>
      )}
    </Page>
  );
}

function Connection({ provider }: { provider: ProviderSummary }) {
  const missing = provider.keyName !== null && !provider.hasKey;
  return (
    <Setting title="Connection">
      <SettingFacts>
        <SettingFact label="Type">{preset(provider.wire).label}</SettingFact>
        <SettingFact label="Base URL" mono>
          {provider.baseUrl}
        </SettingFact>
        <SettingFact
          label="Key file"
          mono={provider.keyName !== null}
          bad={missing}
        >
          {provider.keyName === null
            ? "None"
            : keyLine(provider.keyName, provider.hasKey)}
        </SettingFact>
        <SettingFact label="Added">{longDate(provider.createdAt)}</SettingFact>
      </SettingFacts>
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
  if (total === 0) {
    return (
      <Setting
        title="Used by"
        line="No agent or decider runs on it yet."
        action={
          <PageNew href={newAgentHref(provider.name)} label="New agent" />
        }
      />
    );
  }
  return (
    <Setting list title="Used by" count={String(total)}>
      <AgentLinks
        agents={onAgents}
        href={(a) => configAgentHref(a.name)}
        sub={(a) => a.model.id}
      />
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

function DeleteCard({ provider }: { provider: ProviderSummary }) {
  const agentCount = (agents.value ?? []).filter(
    (a) => a.providerId === provider.id,
  ).length;
  const deciderCount = (deciders.value ?? []).filter(
    (d) => d.providerId === provider.id,
  ).length;
  return (
    <SettingDelete
      title={`Delete ${provider.name}`}
      line={providerDeleteLine(agentCount, deciderCount)}
      ask={`Delete ${provider.name}?`}
      // the server refuses a provider an agent or a decider uses
      off={agentCount + deciderCount > 0}
      onDelete={() => deleteProvider(provider.id)}
      leaveTo={LIST}
    />
  );
}
