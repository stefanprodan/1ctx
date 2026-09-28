// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type {
  McpChange,
  McpServerSummary,
} from "../../../shared/contracts/mcp.ts";
import { AgentLinks } from "../../agents/AgentLinks.tsx";
import { agents } from "../../data/agents.ts";
import {
  callTimeoutMs,
  deleteServer,
  keys,
  loadMcp,
  patchServer,
  refreshServer,
} from "../../data/mcp.ts";
import { ago, commas, showAll } from "../../lib/format.ts";
import { configAgentHref, MCP_HREF } from "../../lib/hrefs.ts";
import { at, useAction, useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { keyOptions, NO_KEY } from "../../lib/secrets.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Fold } from "../../ui/Fold.tsx";
import { NumberBox } from "../../ui/NumberBox.tsx";
import { RowsSwitch } from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  Setting,
  SettingDelete,
  SettingFact,
  SettingFacts,
  SettingForm,
} from "../../ui/Setting.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import { useLatest } from "./drafts.ts";
import {
  changeLine,
  deleteLine,
  instructionsBox,
  instructionsLine,
  mcpFieldOf,
  OFFER_OPTIONS,
  type Offer,
  offerOf,
  offerSides,
  timeoutMs,
  timeoutProblem,
  timeoutText,
  usersOf,
} from "./Mcp.model.ts";
import type { McpDrafts } from "./McpPage.state.ts";

type Props = { server: McpServerSummary; drafts: McpDrafts };

export function McpGeneral({ server, drafts, now }: Props & { now: number }) {
  return (
    <>
      <About server={server} now={now} />
      <Endpoint server={server} drafts={drafts} />
      <Offered server={server} drafts={drafts} />
      <Timeout server={server} drafts={drafts} />
      <Instructions server={server} drafts={drafts} />
      <UsedBy server={server} />
      <Delete server={server} />
    </>
  );
}

function Change({ change, now }: { change: McpChange; now: number }) {
  const named = (
    [
      ["Added", change.added],
      ["Removed", change.removed],
      ["Changed", change.changed],
    ] as const
  ).filter(([, names]) => names.length > 0);
  const line = changeLine(change, now);
  if (named.length === 0) return <>{line}</>;
  return (
    <details class="mcp-page-change">
      <summary class="mcp-page-change-head">{line}</summary>
      {named.map(([label, names]) => (
        <span key={label} class="mcp-page-change-line">
          <span class="mcp-page-change-kind">{label}</span>
          {names.join(", ")}
        </span>
      ))}
    </details>
  );
}

function About({ server, now }: { server: McpServerSummary; now: number }) {
  const refresh = useAction();
  return (
    <Setting
      title="About"
      action={
        <button
          type="button"
          class="btn btn-small"
          disabled={refresh.busy.value}
          onClick={() =>
            void refresh.run(async () => {
              try {
                await refreshServer(server.id);
              } catch (err) {
                // the failed route answers no row: the list holds the failure
                await loadMcp();
                throw err;
              }
            })
          }
        >
          {refresh.busy.value ? "Refreshing" : "Refresh"}
        </button>
      }
    >
      <SettingFacts>
        <SettingFact label="Server" mono>
          {`${server.serverName || "unnamed"} ${server.serverVersion}`.trim()}
        </SettingFact>
        <SettingFact label="Protocol" mono>
          {server.protocolVersion || "unknown"}
        </SettingFact>
        <SettingFact label="Tools">
          {`${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}, listed ${ago(server.checkedAt, now)}`}
        </SettingFact>
        {server.lastChange !== null && (
          <SettingFact label="Last change">
            <Change change={server.lastChange} now={now} />
          </SettingFact>
        )}
      </SettingFacts>
      {/* a recorded failure is already the page's alert */}
      {refresh.failure.value !== null && server.refreshError === null && (
        <p class="error mcp-page-said" role="alert">
          {refresh.failure.value}
        </p>
      )}
    </Setting>
  );
}

function Endpoint({ server, drafts: d }: Props) {
  const latest = useLatest(server);
  const save = useSave(async () => {
    const s = latest.current;
    const body: { url?: string; keyName?: string | null } = {};
    const url = d.url.value.trim();
    const key = d.keyName.value === NO_KEY ? null : d.keyName.value;
    if (url !== s.url) body.url = url;
    if (key !== s.keyName) body.keyName = key;
    d.resetEndpoint(await patchServer(s.id, body));
  }, mcpFieldOf);
  const invalid = (field: string) => save.fieldError(field) !== null;
  return (
    <SettingForm
      save={save}
      check={() =>
        at("url", d.url.value.trim() === "" ? "A URL is required" : null)
      }
    >
      <Setting
        title="Endpoint"
        foot={
          <DraftFoot
            save={save}
            dirty={d.endpointDirty(server)}
            onDiscard={() => d.resetEndpoint(latest.current)}
          />
        }
      >
        <div class="mcp-page-fields">
          <label class="field mcp-page-url">
            <span class="label">URL</span>
            <input
              name="url"
              class="mcp-page-mono"
              autocomplete="off"
              spellcheck={false}
              aria-invalid={invalid("url") || undefined}
              disabled={save.busy}
              value={d.url.value}
              onInput={save.bind(d.url)}
            />
            <FieldError save={save} field="url" />
          </label>
          <div class="field mcp-page-key">
            <span class="label">Key file</span>
            <Select
              label="Key file"
              name="keyName"
              mono
              value={d.keyName.value}
              options={keyOptions(keys.value, d.keyName.value)}
              disabled={save.busy}
              invalid={invalid("keyName")}
              onChange={(value) => {
                d.keyName.value = value;
                save.touch();
              }}
            />
            {invalid("keyName") ? (
              <FieldError save={save} field="keyName" />
            ) : (
              server.keyName !== null && (
                <span class={`hint${server.hasKey ? "" : " error"}`}>
                  {server.hasKey
                    ? `${server.keyName}.key is present`
                    : `${server.keyName}.key is missing`}
                </span>
              )
            )}
          </div>
        </div>
      </Setting>
    </SettingForm>
  );
}

function Offered({ server, drafts: d }: Props) {
  const latest = useLatest(server);
  const save = useSave(async () => {
    d.resetOffer(
      await patchServer(latest.current.id, {
        read: d.read.value,
        write: d.write.value,
      }),
    );
  }, mcpFieldOf);
  const pick = (offer: Offer) => {
    const sides = offerSides(offer);
    d.read.value = sides.read;
    d.write.value = sides.write;
    save.touch();
  };
  return (
    <SettingForm save={save}>
      <Setting
        title="Offered to agents"
        line="Tool set access"
        action={
          <Seg
            label="Offered to agents"
            name="offer"
            value={offerOf(d.read.value, d.write.value)}
            options={OFFER_OPTIONS.map((o) => ({ ...o, disabled: save.busy }))}
            onPick={pick}
          />
        }
        foot={
          <DraftFoot
            save={save}
            dirty={d.offerDirty(server)}
            onDiscard={() => d.resetOffer(latest.current)}
          />
        }
      />
    </SettingForm>
  );
}

function Timeout({ server, drafts: d }: Props) {
  const latest = useLatest(server);
  const save = useSave(async () => {
    d.resetTimeout(
      await patchServer(latest.current.id, {
        timeoutMs: timeoutMs(d.timeout.value),
      }),
    );
  }, mcpFieldOf);
  return (
    <SettingForm
      save={save}
      check={() => at("timeoutMs", timeoutProblem(d.timeout.value))}
    >
      <Setting
        title="Call timeout"
        line="Seconds a call may take."
        foot={
          <DraftFoot
            save={save}
            dirty={d.timeoutDirty(server)}
            hint={
              save.fieldError("timeoutMs") !== null ? (
                <FieldError save={save} field="timeoutMs" />
              ) : undefined
            }
            onDiscard={() => d.resetTimeout(latest.current)}
          />
        }
        action={
          <NumberBox
            label="Call timeout"
            name="timeoutMs"
            class="mcp-page-timeout"
            unit="s"
            placeholder={timeoutText(callTimeoutMs.value)}
            invalid={save.fieldError("timeoutMs") !== null}
            disabled={save.busy}
            value={d.timeout.value}
            onInput={(text) => {
              d.timeout.value = text;
              save.touch();
            }}
          />
        }
      />
    </SettingForm>
  );
}

function Instructions({ server, drafts: d }: Props) {
  const latest = useLatest(server);
  const open = useSignal(false);
  const save = useSave(async () => {
    d.resetInstructions(
      await patchServer(latest.current.id, {
        instructionsOn: d.instructionsOn.value,
      }),
    );
  }, mcpFieldOf);
  if (server.instructions === "") {
    return (
      <Setting title="Instructions" line="The server sent no instructions." />
    );
  }
  const box = instructionsBox(server.name, server.instructions, open.value);
  return (
    <SettingForm save={save}>
      <Setting
        title="Instructions"
        count={`${commas(box.count)} characters`}
        line={instructionsLine(d.instructionsOn.value)}
        foot={
          <DraftFoot
            save={save}
            dirty={d.instructionsDirty(server)}
            onDiscard={() => d.resetInstructions(latest.current)}
          />
        }
        action={
          <RowsSwitch
            on={d.instructionsOn.value}
            label="Instructions"
            disabled={save.busy}
            onClick={() => {
              d.instructionsOn.value = !d.instructionsOn.value;
              save.touch();
            }}
          />
        }
      >
        <Fold
          cut={box.cut && !open.value}
          onOpen={() => {
            open.value = true;
          }}
          label={showAll(box.lines)}
          framed
          ground="card"
        >
          <pre class="textbox mcp-page-block">{box.text}</pre>
        </Fold>
      </Setting>
    </SettingForm>
  );
}

function UsedBy({ server }: { server: McpServerSummary }) {
  const users = byName(usersOf(agents.value ?? [], server.id));
  // Delete's line says no agent uses it
  if (users.length === 0) return null;
  return (
    <Setting list title="Used by" count={String(users.length)}>
      <AgentLinks
        agents={users}
        href={(a) => configAgentHref(a.name, "mcp")}
        sub={(a) =>
          a.servers.find((s) => s.serverId === server.id)?.write
            ? "Read and write"
            : "Read"
        }
      />
    </Setting>
  );
}

function Delete({ server }: { server: McpServerSummary }) {
  const used = usersOf(agents.value ?? [], server.id).length;
  return (
    <SettingDelete
      title={`Delete ${server.name}`}
      line={deleteLine(used)}
      ask={`Delete ${server.name}?`}
      // the server refuses to delete a server an agent uses
      off={used > 0}
      onDelete={() => deleteServer(server.id)}
      leaveTo={MCP_HREF}
    />
  );
}
