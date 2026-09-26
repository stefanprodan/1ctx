// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's page, open to every signed-in user: how it is configured
// and how much it works. The head is the model it runs on, then its
// turns per day in every project, then tabs at their own addresses: its
// system prompt as written, the built-in tools a send offers it now,
// its skills with what each is for, and its MCP servers. The aside is
// the model's facts and the agent's settings, with Manage for an admin;
// where it is hidden, the head carries the provider and the model's
// meta line.

import { useMemo } from "preact/hooks";
import type { DirectoryAgentResponse } from "../../../shared/api/directory.ts";
import {
  modelMeta,
  priceLine,
  shortModel,
  windowLine,
} from "../../agents/meta.ts";
import type { Params } from "../../app/params.ts";
import { path } from "../../app/router.ts";
import {
  agentDays,
  agentDaysFailed,
  agentPage,
  agentPageError,
} from "../../data/directory.ts";
import { me } from "../../data/me.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import { ago, longDate, tokensText } from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { useCut } from "../../lib/resize.ts";
import { Fit } from "../../ui/Fit.tsx";
import { Fold } from "../../ui/Fold.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAvatar,
  RowsBlock,
  RowsCard,
  RowsLine,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Tabs } from "../../ui/Tabs.tsx";
import { Who, WhoLine } from "../../ui/Who.tsx";
import { activityModel } from "../projects/Activity.model.ts";
import { Activity, ActivityGhost } from "../projects/Activity.tsx";
import {
  agentAnswer,
  agentTab,
  agentTabs,
  effortText,
  serverLine,
  serverMeta,
  thinkingText,
} from "./People.model.ts";
import "./people.css";

// a prompt may run to 16,000 characters: cut to its first lines, Show
// all in its fade only when the cut hides something
function Prompt({ text, tokens }: { text: string; tokens: number }) {
  const { el, open, long } = useCut<HTMLPreElement>([text]);
  return (
    <RowsCard label="Prompt" hint={tokensText(tokens)}>
      {/* the row holds the padding, so the cut ends on a whole line */}
      <RowsBlock>
        <Fold
          cut={long.value && !open.value}
          onOpen={() => {
            open.value = true;
          }}
          label="Show all"
          ground="card"
        >
          <pre ref={el} class={`people-prompt${open.value ? "" : " clamp"}`}>
            {text}
          </pre>
        </Fold>
      </RowsBlock>
    </RowsCard>
  );
}

// the agent's turns per day, the Projects page's card over one series;
// its ghost while they load, nothing when their first load failed
function AgentActivity({ name, agentId }: { name: string; agentId: string }) {
  const held = agentDays.value;
  const body = held !== null && held.name === name ? held.body : null;
  const answer = useMemo(
    () => (body === null ? null : agentAnswer(body, agentId)),
    [body, agentId],
  );
  const model = useMemo(
    () => (answer === null ? null : activityModel(answer)),
    [answer],
  );
  if (answer !== null && model !== null) {
    return (
      <Rows>
        <Activity answer={answer} model={model} />
      </Rows>
    );
  }
  // no empty wrapper when the days failed, so the head keeps one gap
  return agentDaysFailed.value ? null : (
    <Rows>
      <ActivityGhost />
    </Rows>
  );
}

function PromptTab({ shown }: { shown: DirectoryAgentResponse }) {
  if (shown.agent.prompt === "") {
    return (
      <RowsCard label="Prompt">
        <RowsNote>No prompt. The model runs on its own defaults.</RowsNote>
      </RowsCard>
    );
  }
  return (
    <Prompt
      key={shown.agent.id}
      text={shown.agent.prompt}
      tokens={shown.tokens.prompt}
    />
  );
}

function ToolsTab({ shown }: { shown: DirectoryAgentResponse }) {
  return (
    <RowsCard
      label="Tools"
      hint={
        shown.tools.length === 0 ? undefined : tokensText(shown.tokens.tools)
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
          {tool.provider !== null && <RowsMeta>{tool.provider}</RowsMeta>}
        </RowsLine>
      ))}
    </RowsCard>
  );
}

function SkillsTab({
  shown,
  now,
}: {
  shown: DirectoryAgentResponse;
  now: number;
}) {
  return (
    <RowsCard
      label="Skills"
      hint={
        shown.skills.length === 0 ? undefined : tokensText(shown.tokens.skills)
      }
    >
      {shown.skills.length === 0 && <RowsNote>No skills.</RowsNote>}
      {shown.skills.map((s) => (
        <RowsLine key={s.id} flush>
          <RowsAvatar>
            <Icon name="skill" size={14} />
          </RowsAvatar>
          <RowsTitle name={s.name} sub={s.description} mono />
          <RowsMeta>fetched {ago(s.fetchedAt, now)}</RowsMeta>
        </RowsLine>
      ))}
    </RowsCard>
  );
}

function McpTab({
  shown,
  now,
}: {
  shown: DirectoryAgentResponse;
  now: number;
}) {
  return (
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
        const line = serverLine(server, now);
        return (
          <RowsLine key={server.name} flush>
            <RowsAvatar>
              <Icon name="mcp" size={14} />
            </RowsAvatar>
            <RowsTitle name={server.name} sub={line.text} bad={line.bad} mono />
            <RowsMeta>{serverMeta(server)}</RowsMeta>
          </RowsLine>
        );
      })}
    </RowsCard>
  );
}

export function Agent({ params }: { params: Params }) {
  const name = params.name ?? "";
  // the fetched-ago words move on the minute
  const now = useNow(60_000);
  const answer = agentPage.value;
  const shown = answer !== null && answer.agent.name === name ? answer : null;
  const tab = agentTab(path.value, name);
  const tabs = shown === null ? [] : agentTabs(name, shown);
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
                <AsideLine label="Provider" cut>
                  {shown.provider}
                </AsideLine>
                <div class="split-line">
                  Model
                  <Fit
                    class="split-strong cut"
                    long={shown.agent.model.id}
                    short={shortModel(shown.agent.model.id)}
                  />
                </div>
                {shown.agent.model.contextLength !== null && (
                  <AsideLine label="Context">
                    {windowLine(shown.agent.model.contextLength)}
                  </AsideLine>
                )}
                {priceLine(
                  shown.agent.model.promptPrice,
                  shown.agent.model.completionPrice,
                ) !== "" && (
                  <AsideLine label="Price">
                    {priceLine(
                      shown.agent.model.promptPrice,
                      shown.agent.model.completionPrice,
                    )}
                  </AsideLine>
                )}
              </AsideSection>
              <AsideSection
                label="Settings"
                action={
                  me.value?.role === "admin" ? (
                    <a
                      class="split-link"
                      href={`/admin/agents?open=${encodeURIComponent(shown.agent.id)}`}
                    >
                      Manage
                    </a>
                  ) : undefined
                }
              >
                <AsideLine label="Thinking">
                  {thinkingText(shown.agent)}
                </AsideLine>
                <AsideLine label="Effort">{effortText(shown.agent)}</AsideLine>
                <AsideLine label="Created">
                  {longDate(shown.agent.createdAt)}
                </AsideLine>
              </AsideSection>
            </>
          }
        >
          <div class="people">
            <Who
              agent
              avatar={<AvatarIcon name={shown.agent.avatar} size={24} />}
              name={shown.agent.model.id}
              mono
            >
              <WhoLine>
                {[shown.provider, modelMeta(shown.agent.model)]
                  .filter((s) => s !== "")
                  .join(" · ")}
              </WhoLine>
            </Who>
            <AgentActivity name={name} agentId={shown.agent.id} />
            <div class="people-tabs">
              <Tabs tabs={tabs} active={tabs[tab].href} />
              <Rows>
                {tab === 0 && <PromptTab shown={shown} />}
                {tab === 1 && <ToolsTab shown={shown} />}
                {tab === 2 && <SkillsTab shown={shown} now={now} />}
                {tab === 3 && <McpTab shown={shown} now={now} />}
              </Rows>
            </div>
          </div>
        </Split>
      )}
    </Page>
  );
}
