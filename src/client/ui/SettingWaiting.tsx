// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A settings page's cards while its first answer loads: each card in
// Setting's own classes, its known title and line in words, a bone at
// a label's and a field's size where each field goes, and the foot's
// buttons, so the cards keep their place when the answer lands. A new
// object's form and an object's page draw from it alike.

import { type ComponentChildren, Fragment } from "preact";
import "./setting.css";
import { Bone, LinesWaiting } from "./Bones.tsx";
import { type RowsShape, RowsWaiting } from "./RowsWaiting.tsx";

// one field's place in the card's two columns
export type FieldBones =
  // a one-line field in one column
  | "input"
  // a one-line field across the card
  | "wide"
  // a few lines of text across the card
  | "text"
  // a prompt's tall box across the card
  | "prompt"
  // a segmented switch under its label, in one column or across
  | "seg"
  | "seg-row"
  // a line of words with no label: a checkbox, a picked model
  | "line"
  // a list's empty note in its box, and a small button under it
  | "box"
  | "button";

export type CardBones = {
  // a title the page knows before the answer: drawn in words
  title?: string;
  // the words under the title, or true for a bone in their place
  line?: string | true;
  // a small button in the head, or a segmented switch
  action?: boolean | "seg";
  fields?: readonly FieldBones[];
  // the landed form's own grid class in place of two columns
  grid?: string;
  // a hint's line under each field, or under those marked true
  hints?: boolean | readonly boolean[];
  // label and value lines, as SettingFacts draws them
  facts?: number;
  // a list card's rows under its head; 0 is the note an empty list
  // lands with
  rows?: number;
  shape?: RowsShape;
  // the card's own bones after the fields, for a form whose landed
  // parts no field bone draws
  body?: ComponentChildren;
  // the foot's buttons: Discard and Save, or one alone
  foot?: 1 | 2;
  danger?: boolean;
};

// the value bones' widths, varied so the facts read as words
const FACT_WIDTHS = [46, 70, 38, 58, 30, 64];

export function FieldBone({
  kind,
  at,
  hint,
  bare,
}: {
  kind: FieldBones;
  at: number;
  hint?: boolean;
  // a field with no label over it, a section's switch or box
  bare?: boolean;
}) {
  if (kind === "button") {
    return (
      <span class="pair-wide">
        <Bone kind="button" at={at} class="bones-bone-small" />
      </span>
    );
  }
  if (kind === "line") {
    return (
      <span class="pair-wide bones-lines-line">
        <Bone kind="line" at={at} width={36} />
      </span>
    );
  }
  return (
    <div
      class={`field${kind === "input" || kind === "seg" ? "" : " pair-wide"}`}
    >
      {!bare && (
        <span class="label bones-lines-line">
          <Bone kind="line" at={at} width={kind === "input" ? 28 : 14} />
        </span>
      )}
      <Bone
        kind={
          kind === "seg" || kind === "seg-row"
            ? "seg"
            : kind === "text"
              ? "area"
              : kind === "box"
                ? "box"
                : kind === "prompt"
                  ? "prompt"
                  : "field"
        }
        at={at + 1}
      />
      {hint && (
        <span class="hint bones-lines-line">
          <Bone kind="line" at={at + 1} width={64} />
        </span>
      )}
    </div>
  );
}

function Card({ card, at }: { card: CardBones; at: number }) {
  const list = card.rows !== undefined;
  const head = (card.title !== undefined || card.action) && (
    <div
      class={`setting-head${card.line === undefined ? " setting-head-one" : ""}`}
    >
      <div class="setting-words">
        {card.title !== undefined && (
          <h2 class="setting-title">{card.title}</h2>
        )}
        {card.line === true ? (
          <p class="setting-line bones-lines-line">
            <Bone kind="line" at={at} width={52} />
          </p>
        ) : (
          card.line !== undefined && <p class="setting-line">{card.line}</p>
        )}
      </div>
      {card.action === "seg" ? (
        <Bone kind="seg" at={at + 1} class="bones-bone-pick" />
      ) : (
        card.action && (
          <Bone kind="button" at={at + 1} class="bones-bone-small" />
        )
      )}
    </div>
  );
  const fields = card.fields ?? [];
  const inner = (
    <>
      {head}
      {fields.length > 0 && (
        <div class={card.grid ?? "pair"}>
          {fields.map((kind, i) => (
            <FieldBone
              key={i}
              kind={kind}
              at={at + 2 + i * 2}
              hint={
                typeof card.hints === "boolean" ? card.hints : card.hints?.[i]
              }
            />
          ))}
        </div>
      )}
      {card.body}
      {card.facts !== undefined && (
        <div class="setting-facts">
          {Array.from({ length: card.facts }, (_, i) => (
            <Fragment key={i}>
              <span class="label bones-lines-line">
                <Bone kind="line" at={at + i} width={70} />
              </span>
              <span class="setting-fact bones-lines-line">
                <Bone
                  kind="line"
                  at={at + i + 1}
                  width={FACT_WIDTHS[i % FACT_WIDTHS.length]}
                />
              </span>
            </Fragment>
          ))}
        </div>
      )}
      {list &&
        (card.rows === 0 ? (
          <LinesWaiting class="rows-note" lines={1} label="Loading" />
        ) : (
          <RowsWaiting
            count={card.rows}
            shape={card.shape ?? "plain"}
            label={card.title ?? "Loading"}
          />
        ))}
    </>
  );
  return (
    <section
      class={`card setting${card.danger ? " setting-danger" : ""}${
        list ? " setting-list" : ""
      }`}
    >
      {list ? inner : <div class="setting-body">{inner}</div>}
      {card.foot !== undefined && (
        <div class="setting-foot">
          <div class="setting-waiting-foot">
            {card.foot === 2 && <Bone kind="button" at={at + 20} />}
            <Bone kind="button" at={at + 21} />
          </div>
        </div>
      )}
    </section>
  );
}

// the cards of a SettingStack, or the one card of a new object's form
export function SettingWaiting({
  label,
  cards,
  lead,
  class: owner,
}: {
  // what is loading, for a screen reader: "Loading the agent"
  label: string;
  cards: readonly CardBones[];
  // what the landed stack opens with that the page already knows: its
  // tabs
  lead?: ComponentChildren;
  // the landed stack's own class, for its width
  class?: string;
}) {
  return (
    <div
      class={`setting-stack bones-wait${owner ? ` ${owner}` : ""}`}
      role="status"
      aria-label={label}
    >
      {lead}
      {cards.map((card, i) => (
        <div key={i} class="setting-waiting-card" aria-hidden="true">
          <Card card={card} at={i * 4} />
        </div>
      ))}
    </div>
  );
}
