// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's page, open to every signed-in user: how it is configured.
// The head is the model it runs on, then its system prompt as written,
// its skills with what each is for, and the built-in tools a send
// offers it now. The aside is the model's facts and the agent's
// settings; where it is hidden, the head carries the provider and the
// model's meta line.

import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import {
  modelMeta,
  priceLine,
  shortModel,
  windowLine,
} from "../../agents/meta.ts";
import type { Params } from "../../app/params.ts";
import { agentPage, agentPageError } from "../../data/directory.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { ago, longDate } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { Fit } from "../../ui/Fit.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAvatar,
  RowsCard,
  RowsLine,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AsideSection, Split } from "../../ui/Split.tsx";
import {
  effortText,
  serverLine,
  serverMeta,
  thinkingText,
  tokensText,
} from "./People.model.ts";
import "./people.css";

// a prompt may run to 16,000 characters: cut to its first lines, with
// Show more only when the cut hides something
function Prompt({ text, tokens }: { text: string; tokens: number }) {
  const open = useSignal(false);
  const long = useSignal(false);
  const el = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (node === null) return;
    const measure = () => {
      if (!open.value) long.value = node.scrollHeight > node.clientHeight + 1;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, open, long]);
  return (
    <RowsCard label="Prompt" hint={tokensText(tokens)}>
      {/* the row holds the padding, so the cut ends on a whole line */}
      <div class="rows-item people-prompt">
        <pre
          ref={el}
          class={`people-prompt-text${open.value ? "" : " people-prompt-cut"}`}
        >
          {text}
        </pre>
        {long.value && (
          <button
            type="button"
            class="people-more"
            aria-expanded={open.value}
            onClick={() => {
              open.value = !open.value;
            }}
          >
            {open.value ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </RowsCard>
  );
}

// the fetched-ago words move on the minute
const MINUTE = 60 * 1000;

export function Agent({ params }: { params: Params }) {
  const name = params.name ?? "";
  const now = useSignal(Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, MINUTE);
    return () => clearInterval(timer);
  }, [now]);
  const answer = agentPage.value;
  const shown = answer !== null && answer.agent.name === name ? answer : null;
  return (
    <Page
      crumb="Agents"
      title={`@${name}`}
      loading={shown === null && agentPageError.value === null}
      error={agentPageError.value}
    >
      {shown && (
        <Split
          aside={
            <>
              <AsideSection label="Model">
                <div class="split-line">
                  Provider
                  <span class="split-strong people-cut">{shown.provider}</span>
                </div>
                <div class="split-line">
                  Model
                  <Fit
                    class="split-strong people-cut"
                    long={shown.agent.model.id}
                    short={shortModel(shown.agent.model.id)}
                  />
                </div>
                {shown.agent.model.contextLength !== null && (
                  <div class="split-line">
                    Context
                    <span class="split-strong">
                      {windowLine(shown.agent.model.contextLength)}
                    </span>
                  </div>
                )}
                {priceLine(
                  shown.agent.model.promptPrice,
                  shown.agent.model.completionPrice,
                ) !== "" && (
                  <div class="split-line">
                    Price
                    <span class="split-strong">
                      {priceLine(
                        shown.agent.model.promptPrice,
                        shown.agent.model.completionPrice,
                      )}
                    </span>
                  </div>
                )}
              </AsideSection>
              <AsideSection label="Settings">
                <div class="split-line">
                  Thinking
                  <span class="split-strong">{thinkingText(shown.agent)}</span>
                </div>
                <div class="split-line">
                  Effort
                  <span class="split-strong">{effortText(shown.agent)}</span>
                </div>
                <div class="split-line">
                  Created
                  <span class="split-strong">
                    {longDate(shown.agent.createdAt)}
                  </span>
                </div>
              </AsideSection>
            </>
          }
        >
          <div class="people">
            <div class="people-head">
              <span class="people-avatar people-avatar-agent">
                <AvatarIcon name={shown.agent.avatar} size={24} />
              </span>
              <div class="people-who">
                <span class="people-name people-name-mono">
                  {shown.agent.model.id}
                </span>
                <span class="people-meta">
                  {[shown.provider, modelMeta(shown.agent.model)]
                    .filter((s) => s !== "")
                    .join(" · ")}
                </span>
              </div>
            </div>
            <Rows>
              {shown.agent.prompt === "" ? (
                <RowsCard label="Prompt">
                  <RowsNote>
                    No prompt. The model runs on its own defaults.
                  </RowsNote>
                </RowsCard>
              ) : (
                <Prompt
                  key={shown.agent.id}
                  text={shown.agent.prompt}
                  tokens={shown.tokens.prompt}
                />
              )}
              <RowsCard
                label="Skills"
                hint={
                  shown.skills.length === 0
                    ? undefined
                    : tokensText(shown.tokens.skills)
                }
              >
                {shown.skills.length === 0 && <RowsNote>No skills.</RowsNote>}
                {shown.skills.map((s) => (
                  <RowsLine key={s.id} flush>
                    <RowsAvatar>
                      <Icon name="skill" size={14} />
                    </RowsAvatar>
                    <RowsTitle name={s.name} sub={s.description} mono />
                    <RowsMeta>fetched {ago(s.fetchedAt, now.value)}</RowsMeta>
                  </RowsLine>
                ))}
              </RowsCard>
              <RowsCard
                label="MCP"
                hint={
                  shown.mcp.servers.length === 0
                    ? undefined
                    : tokensText(shown.mcp.tokens)
                }
              >
                {shown.mcp.servers.length === 0 && (
                  <RowsNote>
                    {shown.agent.model.tools
                      ? "No MCP servers."
                      : "The model does not take tools."}
                  </RowsNote>
                )}
                {shown.mcp.servers.map((server) => {
                  const line = serverLine(server, now.value);
                  return (
                    <RowsLine key={server.name} flush>
                      <RowsAvatar>
                        <Icon name="plug" size={14} />
                      </RowsAvatar>
                      <RowsTitle
                        name={server.name}
                        sub={
                          line.bad ? (
                            <span class="people-bad">{line.text}</span>
                          ) : (
                            line.text
                          )
                        }
                        mono
                      />
                      <RowsMeta>{serverMeta(server)}</RowsMeta>
                    </RowsLine>
                  );
                })}
              </RowsCard>
              <RowsCard
                label="Tools"
                hint={
                  shown.tools.length === 0
                    ? undefined
                    : tokensText(shown.tokens.tools)
                }
              >
                {shown.tools.length === 0 && (
                  <RowsNote>
                    {shown.agent.model.tools
                      ? "No tools are switched on."
                      : "The model does not take tools."}
                  </RowsNote>
                )}
                {shown.tools.map((tool) => (
                  <RowsLine key={tool.name} flush>
                    <RowsAvatar>
                      <Icon name="tools" size={14} />
                    </RowsAvatar>
                    <RowsTitle name={tool.name} mono />
                    {tool.provider !== null && (
                      <RowsMeta>{tool.provider}</RowsMeta>
                    )}
                  </RowsLine>
                ))}
              </RowsCard>
            </Rows>
          </div>
        </Split>
      )}
    </Page>
  );
}
