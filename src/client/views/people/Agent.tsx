// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An agent's page, open to every signed-in user: how it is configured
// and how much it works. The head is the model it runs on, its provider,
// context and price, then its turns per day in every project, then one
// card whose head is tabs at their own addresses: its instructions as
// written with what the model can do at their foot, the built-in tools
// a send offers it now, its skills and its MCP servers, each row a name,
// one line under it and one fact at its end. The aside is the model's
// facts and the agent's settings, with Manage for an admin. The head's
// Favourite makes it the agent the user's new chats start on.

import { type Signal, useSignal } from "@preact/signals";
import { useMemo } from "preact/hooks";
import type { DirectoryAgentResponse } from "../../../shared/api/directory.ts";
import { priceLine, shortModel, windowLine } from "../../agents/meta.ts";
import type { Params } from "../../app/params.ts";
import { path } from "../../app/router.ts";
import {
  agentDays,
  agentDaysFailed,
  agentPage,
  agentPageError,
} from "../../data/directory.ts";
import { setFavourite } from "../../data/favourite.ts";
import { me } from "../../data/me.ts";
import { AvatarIcon } from "../../lib/avatars.tsx";
import {
  ago,
  type Failure,
  failure,
  firstSentence,
  longDate,
} from "../../lib/format.ts";
import { Icon } from "../../lib/icons.tsx";
import { useNow } from "../../lib/now.ts";
import { useCut } from "../../lib/resize.ts";
import { Fit } from "../../ui/Fit.tsx";
import { Fold } from "../../ui/Fold.tsx";
import { Page, PageNotice } from "../../ui/Page.tsx";
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
  agentHint,
  agentLine,
  agentTab,
  agentTabs,
  capabilities,
  effortText,
  filesText,
  serverLine,
  serverMeta,
  thinkingText,
} from "./People.model.ts";
import "./people.css";

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

// what the model can do, at the foot of the instructions it follows
function ModelFoot({ can }: { can: string }) {
  return (
    <RowsBlock>
      <p class="people-foot">
        <Icon name="providers" size={14} />
        <span class="people-foot-name">Capabilities</span>
        {can}
      </p>
    </RowsBlock>
  );
}

// a prompt may run to 16,000 characters: cut to its first lines, Show
// all in its fade only when the cut hides something
function Prompt({ text }: { text: string }) {
  const { el, open, long } = useCut<HTMLPreElement>([text]);
  return (
    // the row holds the padding, so the cut ends on a whole line
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
  );
}

function InstructionsTab({ shown }: { shown: DirectoryAgentResponse }) {
  return (
    <>
      {shown.agent.prompt === "" ? (
        <RowsNote>
          No instructions. The model runs on its own defaults.
        </RowsNote>
      ) : (
        <Prompt key={shown.agent.id} text={shown.agent.prompt} />
      )}
      <ModelFoot can={capabilities(shown.agent.model)} />
    </>
  );
}

function ToolsTab({ shown }: { shown: DirectoryAgentResponse }) {
  if (shown.tools.length === 0) {
    return (
      <RowsNote>
        {shown.agent.model.tools
          ? "No tools are switched on."
          : "The model does not take tools."}
      </RowsNote>
    );
  }
  return (
    <>
      {shown.tools.map((tool) => (
        <RowsLine key={tool.name} flush>
          <RowsAvatar>
            <Icon name="tools" size={14} />
          </RowsAvatar>
          <RowsTitle
            name={tool.name}
            sub={firstSentence(tool.description)}
            mono
          />
          {tool.provider !== null && <RowsMeta>{tool.provider}</RowsMeta>}
        </RowsLine>
      ))}
    </>
  );
}

function SkillsTab({
  shown,
  now,
}: {
  shown: DirectoryAgentResponse;
  now: number;
}) {
  if (shown.skills.length === 0) return <RowsNote>No skills.</RowsNote>;
  return (
    <>
      {shown.skills.map((s) => (
        <RowsLine key={s.id} flush>
          <RowsAvatar>
            <Icon name="skill" size={14} />
          </RowsAvatar>
          <RowsTitle
            name={s.name}
            sub={`fetched ${ago(s.fetchedAt, now)}`}
            mono
          />
          <RowsMeta>{filesText(s.files)}</RowsMeta>
        </RowsLine>
      ))}
    </>
  );
}

function McpTab({
  shown,
  now,
}: {
  shown: DirectoryAgentResponse;
  now: number;
}) {
  if (shown.mcp.servers.length === 0) {
    return (
      <RowsNote>
        {shown.agent.model.tools
          ? "No MCP servers."
          : "The model does not take tools."}
      </RowsNote>
    );
  }
  return (
    <>
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
    </>
  );
}

// on for the user's own pick; a second press follows the default again
function FavouriteButton({
  shown,
  failed,
}: {
  shown: DirectoryAgentResponse;
  // a failure with the agent it was for, since the page stays mounted
  // from one agent to the next
  failed: Signal<{ name: string; failure: Failure } | null>;
}) {
  const busy = useSignal(false);
  const on = shown.favourite;
  const press = async () => {
    busy.value = true;
    failed.value = null;
    try {
      await setFavourite(on ? null : shown.agent.id);
    } catch (err) {
      failed.value = { name: shown.agent.name, failure: failure(err) };
    } finally {
      busy.value = false;
    }
  };
  return (
    <button
      type="button"
      class="btn btn-small"
      aria-pressed={on}
      disabled={busy.value}
      onClick={() => void press()}
    >
      <Icon name="star" size={12} class={on ? "people-fav-on" : undefined} />
      Favourite
    </button>
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
  const failed = useSignal<{ name: string; failure: Failure } | null>(null);
  const failedHere = failed.value?.name === name ? failed.value.failure : null;
  return (
    <Page
      crumb="Agents"
      title={`@${name}`}
      split
      actions={shown && <FavouriteButton shown={shown} failed={failed} />}
      notice={
        failedHere && <PageNotice tone="failed" words={failedHere.words} />
      }
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
                {agentLine(
                  shown.provider,
                  shown.agent.model,
                  shown.agent.default,
                )}
              </WhoLine>
            </Who>
            <AgentActivity name={name} agentId={shown.agent.id} />
            <Rows>
              <RowsCard
                label={tabs[tab].label}
                tabs={<Tabs tabs={tabs} active={tabs[tab].href} head />}
                hint={agentHint(shown, tab)}
              >
                {tab === 0 && <InstructionsTab shown={shown} />}
                {tab === 1 && <ToolsTab shown={shown} />}
                {tab === 2 && <SkillsTab shown={shown} now={now} />}
                {tab === 3 && <McpTab shown={shown} now={now} />}
              </RowsCard>
            </Rows>
          </div>
        </Split>
      )}
    </Page>
  );
}
