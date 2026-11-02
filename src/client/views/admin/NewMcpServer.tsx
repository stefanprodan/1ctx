// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { shapeServerName } from "../../../shared/names.ts";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import { addServer, keys, servers, serversError } from "../../data/mcp.ts";
import { configMcpHref, MCP_HREF } from "../../lib/hrefs.ts";
import { at, useSave } from "../../lib/save.ts";
import { keyOptions, NO_KEY } from "../../lib/secrets.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Labelled } from "../../ui/Labelled.tsx";
import { Page } from "../../ui/Page.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  mcpFieldOf,
  type Personal,
  personalForKey,
  personalHint,
  personalProblem,
  projectsBody,
  projectsProblem,
  type Reach,
  reachForKey,
  reachHint,
} from "./Mcp.model.ts";
import { PersonalSeg, ProjectsPicks, ReachSeg } from "./McpProjects.tsx";
import { NewCard } from "./NewCard.tsx";
import "./mcp-page.css";

const STEPS = [zoneStep("Config"), { label: "MCP Servers", href: MCP_HREF }];

export function NewMcpServer() {
  const error = serversError.value;
  return (
    <Page
      steps={STEPS}
      title="New server"
      loading={servers.value === null && error === null}
      error={error}
    >
      <Form />
    </Page>
  );
}

function Form() {
  const name = useSignal("");
  const url = useSignal("");
  const keyName = useSignal(NO_KEY);
  const reach = useSignal<Reach>(reachForKey(false));
  // until the admin picks, the reach follows the key
  const reachPicked = useSignal(false);
  const projectIds = useSignal<string[]>([]);
  const personal = useSignal<Personal>(personalForKey(false));
  // and the personal grant, by the same rule
  const personalPicked = useSignal(false);
  const keyed = keyName.value !== NO_KEY;
  const save = useSave(async () => {
    const from = address();
    const created = await addServer({
      name: name.value.trim(),
      url: url.value.trim(),
      keyName: keyName.value === NO_KEY ? null : keyName.value,
      // no agent is offered a tool until the Tools tab sets the matchers
      read: true,
      write: false,
      instructionsOn: true,
      timeoutMs: null,
      readPatterns: [],
      writePatterns: [],
      excludedPatterns: [],
      projects: projectsBody(reach.value, projectIds.value),
      ...(personal.value === "" ? {} : { personal: personal.value }),
    });
    if (address() === from) navigate(configMcpHref(created.name, "tools"));
  }, mcpFieldOf);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const busy = save.busy;
  const trimmed = name.value.trim();
  const taken = (servers.value ?? []).some((s) => s.name === trimmed);
  return (
    <NewCard
      label="New server"
      create="Create server"
      cancel={MCP_HREF}
      save={save}
      ready={trimmed !== "" && url.value.trim() !== ""}
      taken={taken ? trimmed : null}
      first="name"
      onSubmit={() => {
        void save.run(
          at("name", trimmed === "" ? "A name is required" : null) ??
            at("url", url.value.trim() === "" ? "A URL is required" : null) ??
            at(
              "projects",
              projectsProblem(keyed, reach.value, projectIds.value),
            ) ??
            at("personal", personalProblem(personal.value)),
        );
      }}
    >
      <div class="pair">
        <label class="field">
          <span class="label label-required">Name</span>
          <input
            name="name"
            class="mcp-page-mono"
            aria-required="true"
            autocomplete="off"
            spellcheck={false}
            aria-invalid={invalid("name") || undefined}
            disabled={busy}
            value={name.value}
            onInput={(e) => {
              name.value = shapeServerName(
                (e.currentTarget as HTMLInputElement).value,
              );
              save.touch();
            }}
          />
          <FieldError save={save} field="name" />
        </label>
        <div class="field">
          <span class="label">Key file</span>
          <Select
            label="Key file"
            name="keyName"
            mono
            value={keyName.value}
            options={keyOptions(keys.value, keyName.value)}
            disabled={busy}
            invalid={invalid("keyName")}
            onChange={(value) => {
              keyName.value = value;
              if (!reachPicked.value)
                reach.value = reachForKey(value !== NO_KEY);
              if (!personalPicked.value)
                personal.value = personalForKey(value !== NO_KEY);
              save.touch();
            }}
          />
          <FieldError save={save} field="keyName" />
        </div>
        <label class="field pair-wide">
          <span class="label label-required">URL</span>
          <input
            name="url"
            class="mcp-page-mono"
            aria-required="true"
            autocomplete="off"
            spellcheck={false}
            placeholder="https://host/mcp"
            aria-invalid={invalid("url") || undefined}
            disabled={busy}
            value={url.value}
            onInput={save.bind(url)}
          />
          <FieldError save={save} field="url" />
        </label>
        <div class="pair-wide">
          <Labelled
            label="Projects"
            field="projects"
            save={save}
            required={keyed}
            hint={reachHint(reach.value, projectIds.value, keyed)}
          >
            <ReachSeg
              reach={reach.value}
              save={save}
              onPick={(value) => {
                if (value === reach.value) return;
                reach.value = value;
                reachPicked.value = true;
                save.touch();
              }}
            />
            {reach.value === "picked" && (
              <ProjectsPicks
                projectIds={projectIds.value}
                held={[]}
                save={save}
                onChange={(ids) => {
                  projectIds.value = ids;
                  save.touch();
                }}
              />
            )}
          </Labelled>
        </div>
        <div class="pair-wide">
          <Labelled
            label="Personal projects"
            field="personal"
            save={save}
            required={keyed}
            hint={personalHint(personal.value, keyed)}
          >
            <PersonalSeg
              personal={personal.value}
              save={save}
              onPick={(value) => {
                if (value === personal.value) return;
                personal.value = value;
                personalPicked.value = true;
                save.touch();
              }}
            />
          </Labelled>
        </div>
      </div>
    </NewCard>
  );
}
