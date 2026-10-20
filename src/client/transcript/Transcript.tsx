// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The transcript in the shell's scroll box. It follows the reply: only
// a scroll upwards lets go, since a programmatic scroll only ever moves
// down, and a new row sticks it to the bottom again. The messages that
// wait for the reply follow the last turn. The foot, stuck to the
// bottom of the window, holds what the view passes (the composer) and
// Jump to latest above it. The Copy button of a code block arrives
// inside the server's HTML, so one delegated listener serves every
// block.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { AutomationDraft } from "../../shared/contracts/automation-draft.ts";
import type {
  LiveRetry,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import { visualPreviews } from "../data/sessions.ts";
import { Icon } from "../lib/icons.tsx";
import { useAction } from "../lib/save.ts";
import { scrollParent } from "../lib/scroll.ts";
import {
  lineAt,
  mayAct,
  nodeKey,
  ownPost,
  prepended,
  quoteOf,
} from "./Channel.model.ts";
import {
  type ChannelView,
  ContextLine,
  MoreLine,
  PendingLine,
  QuoteLine,
  StopTurn,
} from "./Channel.tsx";
import { copyCode } from "./copy.ts";
import { FileCard } from "./FileCard.tsx";
import type { OnFork } from "./Fork.tsx";
import { proposalLines } from "./Proposal.model.ts";
import { Proposal } from "./Proposal.tsx";
import { QueuedRows, type QueueProps } from "./Queued.tsx";
import { type Agent, Reply } from "./Reply.tsx";
import type { Node } from "./rows.ts";
import type { Live } from "./stream.ts";
import { type Box, following } from "./Transcript.model.ts";
import { UserRow } from "./UserRow.tsx";
import { Visual } from "./Visual.tsx";
import { isFileCard, visualCards } from "./visuals.ts";
import "./transcript.css";
import "./md.css";
import "./hljs.css";

const NO_RETRIES: ReadonlyMap<string, LiveRetry> = new Map();
// how near the top an older page starts loading
const OLDER_AT = 600;

const boxOf = (el: HTMLElement): Box => ({
  top: el.scrollTop,
  height: el.scrollHeight,
  client: el.clientHeight,
});

export function Transcript({
  sessionId,
  nodes,
  live,
  agentOf,
  authorOf,
  onRegenerate,
  fork,
  foot,
  queue,
  proposals,
  retries = NO_RETRIES,
  marked = false,
  channel,
}: {
  sessionId: string;
  nodes: Node[];
  live: ReadonlyMap<string, Live>;
  // each send's round waiting to ask its provider again, by send id
  retries?: ReadonlyMap<string, LiveRetry>;
  // a run its agent marked (agentMarked()), which the fold after its
  // answer says
  marked?: boolean;
  // the agent a reply names, by the row's agent id; null for one no
  // longer listed, and for a turn with no row yet the session's
  agentOf: (agentId: string | null) => Agent | null;
  // the author's name, and the username for the link to their page
  authorOf: (userId: string | null) => {
    name: string;
    username: string | null;
  };
  // the last turn's Regenerate; absent while a send runs
  onRegenerate?: () => Promise<void>;
  // Fork under every finished answer; absent in a run
  fork?: { agents: AgentSummary[]; agentId: string | null; onFork: OnFork };
  // the messages that wait, under the last turn
  queue?: QueueProps;
  // a chat's automation proposals, drawn under the turn whose call made them
  proposals?: {
    drafts: AutomationDraft[];
    session: Pick<SessionSummary, "forkedFromId" | "createdAt">;
  };
  foot?: ComponentChildren;
  // a project channel's lines, pages and turn actions
  channel?: ChannelView;
}) {
  const rows = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement | null>(null);
  const stick = useRef(true);
  // from a chat's opening to the user's first input, rows that grow with
  // no render (a font swap, a visual loading) are followed; after it a
  // fold or Show all the user opened must stay where it is
  const settling = useRef(true);
  const last = useRef<Box>({ top: 0, height: 0, client: 0 });
  const jumpHidden = useSignal(true);

  const footEl = useRef<HTMLDivElement>(null);
  // the first row on screen and the box at the last render, so a page
  // that lands above keeps the reader's place
  const seen = useRef<{ first: string | null; top: number; height: number }>({
    first: null,
    top: 0,
    height: 0,
  });
  const olderRef = useRef(channel?.older);
  olderRef.current = channel?.older;

  const toEnd = () => {
    const scroller = box.current;
    // an observer can fire after the rows leave and before the cleanup,
    // and the scroller is the next page's
    if (!scroller || !rows.current?.isConnected) return;
    scroller.scrollTop = scroller.scrollHeight;
    last.current = boxOf(scroller);
  };

  const follow = () => {
    if (stick.current) toEnd();
  };

  useEffect(() => {
    const el = rows.current;
    const scroller = el ? scrollParent(el) : null;
    box.current = scroller;
    if (!el || !scroller) return;
    const onScroll = () => {
      const next = boxOf(scroller);
      stick.current = following(stick.current, last.current, next);
      last.current = next;
      seen.current = { ...seen.current, top: next.top, height: next.height };
      jumpHidden.value =
        stick.current || next.height - next.top - next.client < 80;
      const older = olderRef.current;
      if (
        older?.more &&
        !older.loading &&
        older.failure === null &&
        next.top < OLDER_AT
      ) {
        older.onOlder();
      }
    };
    // the foot grows with the draft, and the box shrinks while a
    // phone's keyboard is up: either would cover the last rows, so a
    // view that follows the end keeps following, one that let go
    // learns whether Jump applies
    const grown = new ResizeObserver(() => {
      if (stick.current) toEnd();
      else onScroll();
    });
    if (footEl.current) grown.observe(footEl.current);
    grown.observe(scroller);
    // rows that shrink while the view is at the top move nothing, so no
    // scroll event tells Jump that the end is in view again
    const resized = new ResizeObserver(() => {
      if (settling.current && stick.current) toEnd();
      const gap =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (gap < 40) stick.current = true;
      jumpHidden.value = stick.current || gap < 80;
    });
    resized.observe(el);
    const onClick = (ev: MouseEvent) => void copyCode(ev);
    const settled = () => {
      settling.current = false;
    };
    const inputs = ["pointerdown", "click", "wheel", "keydown"] as const;
    for (const name of inputs) {
      window.addEventListener(name, settled, { capture: true, passive: true });
    }
    scroller.addEventListener("scroll", onScroll);
    el.addEventListener("click", onClick);
    return () => {
      grown.disconnect();
      resized.disconnect();
      for (const name of inputs) {
        window.removeEventListener(name, settled, { capture: true });
      }
      scroller.removeEventListener("scroll", onScroll);
      el.removeEventListener("click", onClick);
    };
  }, [jumpHidden]);

  // a chat opens at its end
  useLayoutEffect(() => {
    stick.current = true;
    settling.current = true;
    if (box.current === null && rows.current) {
      box.current = scrollParent(rows.current);
    }
    toEnd();
    jumpHidden.value = true;
  }, [sessionId, jumpHidden]);
  // a new row sticks the view to the bottom again, a waiting one too;
  // an older page lands above and moves nothing
  const waiting = queue?.rows.length ?? 0;
  const shown = channel
    ? nodes.filter(
        (node) => node.kind !== "user" || channel.shown(node.message.seq),
      )
    : nodes;
  const keys = shown.map(nodeKey);
  const lastKey = keys.at(-1) ?? null;
  // in a channel only the reader's own post pulls them down: others'
  // posts and turns land while they read, and Jump says so
  const restick = channel === undefined || ownPost(shown.at(-1), channel);
  useLayoutEffect(() => {
    if (restick) stick.current = true;
  }, [lastKey, waiting]);
  useLayoutEffect(() => {
    const scroller = box.current;
    const was = seen.current;
    if (scroller !== null && !stick.current && prepended(was.first, keys)) {
      scroller.scrollTop = was.top + (scroller.scrollHeight - was.height);
    }
    if (stick.current) toEnd();
    seen.current = {
      first: keys[0] ?? null,
      top: scroller?.scrollTop ?? 0,
      height: scroller?.scrollHeight ?? 0,
    };
  });
  // a quote's post, once drawn
  const focus = channel?.focus ?? null;
  const onFocused = channel?.onFocused;
  useLayoutEffect(() => {
    if (focus === null) return;
    const el = rows.current?.querySelector(
      `[data-post="${CSS.escape(focus)}"]`,
    );
    if (!el) return;
    stick.current = false;
    el.scrollIntoView({ block: "center" });
    onFocused?.();
  }, [focus, onFocused]);
  const posts = new Map(
    nodes.flatMap((node) =>
      node.kind === "user" ? [[node.message.id, node.message] as const] : [],
    ),
  );
  const contextAt = lineAt(shown, channel?.droppedSeq ?? null);
  const gapAt = lineAt(shown, channel?.gap?.before ?? null);

  return (
    <>
      <div class="transcript-rows" ref={rows}>
        <div class="transcript">
          {channel?.older.more && (
            <MoreLine
              words="Show older"
              loading={channel.older.loading}
              failure={channel.older.failure}
              onMore={channel.older.onOlder}
            />
          )}
          {shown.flatMap((node, index) => {
            const last = index === shown.length - 1;
            // flat and keyed, so a page landing above moves no row
            const before = [
              ...(index === contextAt ? [<ContextLine key="context" />] : []),
              ...(index === gapAt && channel?.gap
                ? [<GapLine key="gap" onGap={channel.gap.onGap} />]
                : []),
            ];
            if (node.kind === "user") {
              return [
                ...before,
                <UserRow
                  key={node.message.id}
                  message={node.message}
                  author={authorOf(node.message.userId)}
                  channel={channel !== undefined}
                />,
                ...(channel?.pending ?? [])
                  .filter((turn) => turn.messageId === node.message.id)
                  .map((turn) => (
                    <PendingLine
                      key={`pending:${turn.id}`}
                      turn={turn}
                      agent={channel!.agentName(turn.agentId)}
                      onCancel={
                        mayAct(channel!.viewer, turn.authorId)
                          ? () => channel!.onCancel(turn.id)
                          : undefined
                      }
                    />
                  )),
              ];
            }
            const quote =
              channel === undefined
                ? null
                : quoteOf(node.send?.firstMessageId ?? null, posts);
            const send = node.send;
            return [
              ...before,
              <Reply
                key={`reply:${node.sendId}`}
                node={node}
                quote={
                  quote !== null &&
                  channel !== undefined && (
                    <QuoteLine
                      quote={quote}
                      author={authorOf(quote.post.userId).name}
                      onOpen={() => void channel.onQuote(quote.post)}
                    />
                  )
                }
                head={
                  channel !== undefined &&
                  send?.status === "running" &&
                  mayAct(channel.viewer, send.userId) && (
                    <StopTurn onStop={() => channel.onStop(send.id)} />
                  )
                }
                live={live}
                agent={agentOf(
                  node.message?.agentId ??
                    node.rows.find((row) => row.kind === "reply")?.agentId ??
                    null,
                )}
                onRegenerate={last ? onRegenerate : undefined}
                follow={last ? follow : undefined}
                retry={retries.get(node.sendId) ?? null}
                marked={marked}
                fork={fork}
                visuals={[
                  ...visualCards(node, visualPreviews.value).map((card) =>
                    isFileCard(card) ? (
                      <FileCard key={card.key} card={card} />
                    ) : (
                      <Visual key={card.key} card={card} />
                    ),
                  ),
                  ...(proposals === undefined
                    ? []
                    : proposalLines(
                        node,
                        proposals.drafts,
                        proposals.session,
                      ).map((line) => <Proposal key={line.key} line={line} />)),
                ]}
              />,
            ];
          })}
          {queue !== undefined && <QueuedRows {...queue} />}
        </div>
      </div>
      <div class="transcript-foot" ref={footEl}>
        <button
          type="button"
          class="transcript-jump"
          aria-label="Jump to latest"
          title="Jump to latest"
          hidden={jumpHidden.value}
          onClick={() => {
            stick.current = true;
            const scroller = box.current;
            if (scroller) {
              scroller.scrollTo({
                top: scroller.scrollHeight,
                behavior: "smooth",
              });
            }
          }}
        >
          <Icon name="down" />
        </button>
        {foot}
      </div>
    </>
  );
}

// the posts a window leaves between it and the newest pages
function GapLine({ onGap }: { onGap: () => Promise<void> }) {
  const action = useAction();
  return (
    <MoreLine
      words="Show newer"
      loading={action.busy.value}
      failure={action.failure.value}
      onMore={() => void action.run(onGap)}
    />
  );
}
