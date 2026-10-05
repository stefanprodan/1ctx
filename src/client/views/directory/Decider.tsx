// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A decider's page, open to every signed-in user: the model that judges
// and how often it is asked. The head is the model, its provider,
// window and price, then its answers per day in every project, then the
// decisions it answers now, each drawn as the admin's Decisions list
// draws it, from the words in code: its options and an admin's text
// stay on the admin pages, and the row is no link, since a member
// cannot open them. The aside is the model's facts and when the
// decider was added, with Manage for an admin.

import { useMemo } from "preact/hooks";
import { shortModel, windowLine } from "../../agents/meta.ts";
import type { Params } from "../../app/params.ts";
import {
  deciderDays,
  deciderDaysFailed,
  deciderPage,
  deciderPageError,
} from "../../data/directory.ts";
import { me } from "../../data/me.ts";
import { longDate } from "../../lib/format.ts";
import {
  configDeciderHref,
  DIRECTORY_DECIDERS_HREF,
  DIRECTORY_HREF,
} from "../../lib/hrefs.ts";
import { Icon } from "../../lib/icons.tsx";
import { Fit } from "../../ui/Fit.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAvatar,
  RowsCard,
  RowsLine,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { Who, WhoLine } from "../../ui/Who.tsx";
import { inputPriceLine } from "../admin/Deciders.model.ts";
import { DECISION_WORDS } from "../admin/Decisions.model.ts";
import { ANSWER_WORDS, activityModel } from "../projects/Activity.model.ts";
import { Activity, ActivityGhost } from "../projects/Activity.tsx";
import { deciderAnswer, deciderLine } from "./Directory.model.ts";
import "./directory.css";

// the decider's answers per day, the agent page's card in its words;
// its ghost while they load, nothing when their first load failed
function DeciderActivity({
  name,
  deciderId,
}: {
  name: string;
  deciderId: string;
}) {
  const held = deciderDays.value;
  const body = held !== null && held.name === name ? held.body : null;
  const answer = useMemo(
    () => (body === null ? null : deciderAnswer(body, deciderId)),
    [body, deciderId],
  );
  const model = useMemo(
    () => (answer === null ? null : activityModel(answer)),
    [answer],
  );
  if (answer !== null && model !== null) {
    return (
      <Rows>
        <Activity answer={answer} model={model} words={ANSWER_WORDS} />
      </Rows>
    );
  }
  return deciderDaysFailed.value ? null : (
    <Rows>
      <ActivityGhost />
    </Rows>
  );
}

export function Decider({ params }: { params: Params }) {
  const name = params.name ?? "";
  const answer = deciderPage.value;
  const shown = answer !== null && answer.decider.name === name ? answer : null;
  return (
    <Page
      steps={[
        { label: "Directory", href: DIRECTORY_HREF },
        { label: "Deciders", href: DIRECTORY_DECIDERS_HREF },
      ]}
      title={name}
      titleMono
      loading={shown === null && deciderPageError.value === null}
      error={deciderPageError.value}
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
                    long={shown.decider.model}
                    short={shortModel(shown.decider.model)}
                  />
                </div>
                {shown.decider.contextLength !== null && (
                  <AsideLine label="Context">
                    {windowLine(shown.decider.contextLength)}
                  </AsideLine>
                )}
                {shown.decider.promptPrice !== null && (
                  <AsideLine label="Price">
                    {inputPriceLine(shown.decider.promptPrice)}
                  </AsideLine>
                )}
              </AsideSection>
              <AsideSection
                label="Decider"
                action={
                  me.value?.role === "admin" ? (
                    <a
                      class="split-link"
                      href={configDeciderHref(shown.decider.name)}
                    >
                      Manage
                    </a>
                  ) : undefined
                }
              >
                <AsideLine label="Added">
                  {longDate(shown.decider.createdAt)}
                </AsideLine>
              </AsideSection>
            </>
          }
        >
          <div class="directory">
            <Who
              avatar={<Icon name="check" size={24} />}
              name={shown.decider.model}
              mono
            >
              <WhoLine>{deciderLine(shown.provider, shown.decider)}</WhoLine>
            </Who>
            <DeciderActivity name={name} deciderId={shown.decider.id} />
            <Rows>
              <RowsCard label="Decisions">
                {shown.decisions.length === 0 && (
                  <RowsNote>No decision asks this decider.</RowsNote>
                )}
                {shown.decisions.map((id) => {
                  const words = DECISION_WORDS[id];
                  return (
                    <RowsLine key={id} flush>
                      <RowsAvatar>
                        <Icon name={words.icon} size={15} />
                      </RowsAvatar>
                      <RowsTitle name={words.title} sub={words.sub} />
                    </RowsLine>
                  );
                })}
              </RowsCard>
            </Rows>
          </div>
        </Split>
      )}
    </Page>
  );
}
