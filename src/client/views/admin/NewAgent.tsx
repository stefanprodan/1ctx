// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New agent: what an agent cannot exist without, in one card with one
// Create, as GitHub's new repository asks only a name. The name card's
// fields and the Model card's, the model search open on the provider
// `?provider=` names (a provider page's New agent), else the default
// agent's; Create opens the agent's page, where skills and MCP
// servers are added with the cards that edit them.

import { useRef } from "preact/hooks";
import { navigate, query } from "../../app/router.ts";
import { agents, createAgent } from "../../data/agents.ts";
import { providers, providersError } from "../../data/providers.ts";
import { configAgentHref, configProviderHref } from "../../lib/hrefs.ts";
import { nameProblem } from "../../lib/names.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { Setting, SettingHint } from "../../ui/Setting.tsx";
import { cardFieldOf, nameTaken } from "./AgentPage.model.ts";
import { AgentDrafts } from "./AgentPage.state.ts";
import { ModelFields } from "./ModelFields.tsx";
import { NameFields } from "./NameFields.tsx";
import "./agent-page.css";
import "./agent-new.css";

const STEPS = [
  { label: "Config", href: "/config" },
  { label: "Agents", href: "/config/agents" },
];

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
            <a href="/config/providers">Add a provider</a> first.
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
  // read when it runs: the save is made once, maybe before the
  // providers loaded
  const wireOf = () =>
    providers.value?.find((p) => p.id === d.providerId.value)?.wire;
  const save = useSave(
    async () => {
      const created = await createAgent({
        name: d.name.value.trim(),
        avatar: d.avatar.value,
        prompt: d.prompt.value.trim(),
        ...d.modelBody(wireOf()),
        skills: [],
        servers: [],
        mcpMode: "auto",
      });
      navigate(configAgentHref(created.name));
    },
    cardFieldOf(["name", "prompt", "model", "upstream", "contextLength"]),
  );
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  const name = d.name.value.trim();
  // Cancel returns to the provider page that asked, else to the list
  const from = new URLSearchParams(query.value).get("provider");
  const back =
    from !== null && providers.value?.some((p) => p.name === from)
      ? configProviderHref(from)
      : "/config/agents";
  const taken = nameTaken(name, agents.value, "");
  return (
    <form
      ref={form}
      class="agent-new"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(
          at("name", nameProblem(d.name.value)) ?? d.modelProblem(),
        );
      }}
    >
      <Setting
        label="New agent"
        foot={
          <Foot
            save={save}
            dirty={
              name !== "" &&
              !taken &&
              d.model.value !== null &&
              !d.changing.value
            }
            label="Create agent"
            stack={taken}
            // the hint's place holds the buttons at the right
            start={
              <SettingHint>
                {taken && <span class="error">@{name} is taken.</span>}
              </SettingHint>
            }
            before={
              <a class="btn" href={back}>
                Cancel
              </a>
            }
          />
        }
      >
        <NameFields drafts={d} save={save} fresh />
        <div class="agent-new-model">
          <span class="label">Model</span>
          <ModelFields drafts={d} save={save} currentId={null} fresh />
        </div>
      </Setting>
    </form>
  );
}
