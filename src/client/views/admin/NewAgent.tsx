// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useRef } from "preact/hooks";
import { address, navigate, query } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { agents, createAgent } from "../../data/agents.ts";
import { providers, providersError } from "../../data/providers.ts";
import {
  AGENTS_HREF,
  configAgentHref,
  configProviderHref,
  PROVIDERS_HREF,
} from "../../lib/hrefs.ts";
import { nameProblem, nameTaken } from "../../lib/names.ts";
import { at, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
import { cardFieldOf } from "./AgentPage.model.ts";
import { AgentDrafts } from "./AgentPage.state.ts";
import { ModelFields } from "./ModelFields.tsx";
import { NameFields } from "./NameFields.tsx";
import { NewCard } from "./NewCard.tsx";
import "./agent-new.css";

const STEPS = [zoneStep("Config"), { label: "Agents", href: AGENTS_HREF }];

export function NewAgent() {
  const rows = providers.value;
  const error = providersError.value;
  return (
    <Page
      steps={STEPS}
      title="New agent"
      loading={rows === null && error === null}
      error={error}
    >
      {rows !== null &&
        (rows.length === 0 ? (
          <p class="page-state">
            An agent runs on a provider's model.{" "}
            <a href={PROVIDERS_HREF}>Add a provider</a> first.
          </p>
        ) : (
          <Form
            providerId={
              rows.find(
                (p) =>
                  p.name === new URLSearchParams(query.value).get("provider"),
              )?.id ??
              agents.value?.find((a) => a.default)?.providerId ??
              byName(rows)[0]!.id
            }
          />
        ))}
    </Page>
  );
}

function Form({ providerId }: { providerId: string }) {
  const drafts = useRef<AgentDrafts | null>(null);
  if (drafts.current === null) drafts.current = AgentDrafts.blank(providerId);
  const d = drafts.current;
  // read at call time: the save is made once, maybe before the providers
  // loaded
  const wireOf = () =>
    providers.value?.find((p) => p.id === d.providerId.value)?.wire;
  const save = useSave(
    async () => {
      const from = address();
      const created = await createAgent({
        name: d.name.value.trim(),
        avatar: d.avatar.value,
        prompt: d.prompt.value.trim(),
        ...d.modelBody(wireOf()),
        skills: [],
        servers: [],
        mcpMode: "auto",
      });
      if (address() === from) navigate(configAgentHref(created.name));
    },
    cardFieldOf([
      "name",
      "prompt",
      "model",
      "upstream",
      "skip4Bit",
      "contextLength",
    ]),
  );
  const name = d.name.value.trim();
  const asked = new URLSearchParams(query.value).get("provider");
  const cancel =
    asked !== null && providers.value?.some((p) => p.name === asked)
      ? configProviderHref(asked)
      : AGENTS_HREF;
  return (
    <NewCard
      label="New agent"
      create="Create agent"
      cancel={cancel}
      save={save}
      ready={name !== "" && d.model.value !== null && !d.changing.value}
      taken={nameTaken(agents.value, name) ? `@${name}` : null}
      first="name"
      onSubmit={() =>
        void save.run(at("name", nameProblem(d.name.value)) ?? d.modelProblem())
      }
    >
      <NameFields drafts={d} save={save} fresh />
      <div class="agent-new-model">
        <span class="label">Model</span>
        <ModelFields drafts={d} save={save} currentId={null} fresh />
      </div>
    </NewCard>
  );
}
