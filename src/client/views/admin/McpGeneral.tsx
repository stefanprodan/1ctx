// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP server's General tab, a card per setting that saves apart,
// each sending only its own fields: what the server said about itself
// with Refresh, the endpoint (its save lists the tools again first, and
// a refusal keeps what was typed), the sides agents may be offered, the
// call timeout, the instructions as the prompt carries them, then the
// agents that use it and Delete from McpUsedBy.tsx.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import type {
  McpChange,
  McpServerSummary,
} from "../../../shared/contracts/mcp.ts";
import {
  callTimeoutMs,
  keys,
  loadMcp,
  patchServer,
  refreshServer,
} from "../../data/mcp.ts";
import { ago, showAll } from "../../lib/format.ts";
import { at, useAction, useFocusField, useSave } from "../../lib/save.ts";
import { keyOptions, NO_KEY } from "../../lib/secrets.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Fold } from "../../ui/Fold.tsx";
import { NumberBox } from "../../ui/NumberBox.tsx";
import { RowsSwitch } from "../../ui/Rows.tsx";
import { Seg } from "../../ui/Seg.tsx";
import { Select } from "../../ui/Select.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { DraftFoot } from "./DraftFoot.tsx";
import {
  changeLine,
  characters,
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
} from "./Mcp.model.ts";
import type { McpDrafts } from "./McpPage.state.ts";
import { DeleteCard, UsedBy } from "./McpUsedBy.tsx";

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
      <DeleteCard server={server} />
    </>
  );
}

// the row a save answered, read when the call ends: a later render may
// have a newer one
function useLatest(server: McpServerSummary) {
  const latest = useRef(server);
  latest.current = server;
  return latest;
}

function Fact({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ComponentChildren;
}) {
  return (
    <>
      <span class="label">{label}</span>
      <span class={`mcp-page-fact${mono ? " mcp-page-fact-mono" : ""}`}>
        {children}
      </span>
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

// what the server said about itself and when its tools were listed;
// Refresh lists them again
function About({ server, now }: { server: McpServerSummary; now: number }) {
  const refresh = useAction();
  const n = server.tools.length;
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
                // the failed route has no row: read the failure it kept
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
      <div class="mcp-page-facts">
        <Fact label="Server" mono>
          {`${server.serverName || "unnamed"} ${server.serverVersion}`.trim()}
        </Fact>
        <Fact label="Protocol" mono>
          {server.protocolVersion || "unknown"}
        </Fact>
        <Fact label="Tools">
          {`${n} ${n === 1 ? "tool" : "tools"}, listed ${ago(server.checkedAt, now)}`}
        </Fact>
        {server.lastChange !== null && (
          <Fact label="Last change">
            <Change change={server.lastChange} now={now} />
          </Fact>
        )}
      </div>
      {/* a recorded failure is already the page's head */}
      {refresh.failure.value !== null && server.refreshError === null && (
        <p class="error mcp-page-said" role="alert">
          {refresh.failure.value}
        </p>
      )}
    </Setting>
  );
}

// the address and the key; a save lists the tools there first, and a
// server that does not answer keeps what was typed with its words
function Endpoint({ server, drafts: d }: Props) {
  const latest = useLatest(server);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    const s = latest.current;
    const body: { url?: string; keyName?: string | null } = {};
    const url = d.url.value.trim();
    const key = d.keyName.value === NO_KEY ? null : d.keyName.value;
    if (url !== s.url) body.url = url;
    if (key !== s.keyName) body.keyName = key;
    d.resetEndpoint(await patchServer(s.id, body));
  }, mcpFieldOf);
  useFocusField(save, form);
  const invalid = (field: string) => save.fieldError(field) !== null;
  const dirty = d.endpointDirty(server);
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(
          at("url", d.url.value.trim() === "" ? "A URL is required" : null),
        );
      }}
    >
      <Setting
        title="Endpoint"
        foot={
          <DraftFoot
            save={save}
            dirty={dirty}
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
    </form>
  );
}

// the most an agent may be given; an agent picks Read, or Read and
// write, within them
function Offered({ server, drafts: d }: Props) {
  const latest = useLatest(server);
  const save = useSave(async () => {
    d.resetSettings(
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
  const dirty = d.read.value !== server.read || d.write.value !== server.write;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
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
            dirty={dirty}
            onDiscard={() => {
              d.read.value = latest.current.read;
              d.write.value = latest.current.write;
            }}
          />
        }
      />
    </form>
  );
}

function Timeout({ server, drafts: d }: Props) {
  const latest = useLatest(server);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    const saved = await patchServer(latest.current.id, {
      timeoutMs: timeoutMs(d.timeout.value),
    });
    d.timeout.value = timeoutText(saved.timeoutMs);
  }, mcpFieldOf);
  useFocusField(save, form);
  const dirty = timeoutMs(d.timeout.value) !== server.timeoutMs;
  const limit = callTimeoutMs.value;
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(at("timeoutMs", timeoutProblem(d.timeout.value)));
      }}
    >
      <Setting
        title="Call timeout"
        line="Seconds a call may take."
        foot={
          <DraftFoot
            save={save}
            dirty={dirty}
            hint={
              save.fieldError("timeoutMs") !== null ? (
                <FieldError save={save} field="timeoutMs" />
              ) : undefined
            }
            onDiscard={() => {
              d.timeout.value = timeoutText(latest.current.timeoutMs);
            }}
          />
        }
        action={
          <NumberBox
            label="Call timeout"
            name="timeoutMs"
            class="mcp-page-timeout"
            unit="s"
            placeholder={timeoutText(limit)}
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
    </form>
  );
}

// the block as the prompt carries it; the switch leaves it out
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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <Setting
        title="Instructions"
        count={characters(box.count)}
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
    </form>
  );
}
