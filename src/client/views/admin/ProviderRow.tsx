// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A provider row on the agents page: its mark, the name over the base
// URL, the wire and the key. It opens to what it is, never edited: the
// wire, the base URL, the key file, the agents and deciders on it and
// when it was added, then Delete, asked once. The server refuses a
// provider an agent or a decider uses, and the foot says so.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import type { ProviderSummary } from "../../../shared/contracts/provider.ts";
import type { Wire } from "../../../shared/words.ts";
import { agents } from "../../data/agents.ts";
import { deciders } from "../../data/deciders.ts";
import { deleteProvider } from "../../data/providers.ts";
import { longDate } from "../../lib/format.ts";
import { agentHref } from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { hasMark, WireMark } from "../../lib/marks.tsx";
import { useSave } from "../../lib/save.ts";
import { byName } from "../../lib/search.ts";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { RowsAvatar, RowsMeta, RowsOpen, RowsTitle } from "../../ui/Rows.tsx";
import { keyLine } from "./Agents.model.ts";
import "./agents.css";

// a provider shows its service's mark, or a cloud for a server
// without one
function Tile({ wire, lit }: { wire: Wire; lit: boolean }) {
  return (
    <RowsAvatar lit={lit}>
      {hasMark(wire) ? (
        <WireMark wire={wire} size={15} />
      ) : (
        <Icon name="providers" size={15} />
      )}
    </RowsAvatar>
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
  children: ComponentChildren;
}) {
  return (
    <>
      <span class="label">{label}</span>
      <span
        class={`agents-fact${mono ? " agents-fact-mono" : ""}${
          bad ? " error" : ""
        }`}
      >
        {children}
      </span>
    </>
  );
}

export function ProviderRow({
  provider,
  open,
  onToggle,
}: {
  provider: ProviderSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const asking = useSignal(false);
  const save = useSave(async () => {});
  const keyMissing = provider.keyName !== null && !provider.hasKey;
  const onAgents = byName(agents.value ?? []).filter(
    (a) => a.providerId === provider.id,
  );
  const onDeciders = byName(deciders.value ?? []).filter(
    (d) => d.providerId === provider.id,
  );
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      head={
        <>
          <Tile wire={provider.wire} lit={open} />
          <RowsTitle mono name={provider.name} sub={provider.baseUrl} />
          <RowsMeta bad={keyMissing}>
            {provider.wire} · {keyLine(provider.keyName, provider.hasKey)}
          </RowsMeta>
        </>
      }
    >
      <div class="agents-open">
        <div class="agents-facts">
          <Fact label="Wire" mono>
            {provider.wire}
          </Fact>
          <Fact label="Base URL" mono>
            {provider.baseUrl}
          </Fact>
          <Fact label="Key" mono bad={keyMissing}>
            {keyLine(provider.keyName, provider.hasKey)}
          </Fact>
          <Fact label="Agents">
            {onAgents.length === 0
              ? "None"
              : onAgents.map((a, i) => (
                  <span key={a.id}>
                    {i > 0 && ", "}
                    <a href={agentHref(a.name)}>{a.name}</a>
                  </span>
                ))}
          </Fact>
          <Fact label="Deciders">
            {onDeciders.length === 0
              ? "None"
              : onDeciders.map((d) => d.name).join(", ")}
          </Fact>
          <Fact label="Added">{longDate(provider.createdAt)}</Fact>
        </div>
        <Foot
          save={save}
          start={
            <AskDelete
              save={save}
              asking={asking}
              busy={save.busy}
              words={`Delete ${provider.name}?`}
              wordsClass="agents-ask-words"
              onDelete={() =>
                void save.act("delete", () => deleteProvider(provider.id))
              }
            />
          }
        >
          <button type="button" class="btn" onClick={onToggle}>
            Close
          </button>
        </Foot>
      </div>
    </RowsOpen>
  );
}
