// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The transcript in the shell's scroll box. It follows the reply: only
// a scroll upwards lets go, since a programmatic scroll only ever moves
// down, and a new row sticks it to the bottom again. The foot, stuck to
// the bottom of the window, holds what the view passes (the composer)
// and Jump to latest above it. The Copy button of a code block arrives
// inside the server's HTML, so one delegated listener serves every
// block.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { visualPreviews } from "../data/sessions.ts";
import { Icon } from "../lib/icons.tsx";
import { scrollParent } from "../lib/scroll.ts";
import { copyCode } from "./copy.ts";
import { FileCard } from "./FileCard.tsx";
import type { OnFork } from "./Fork.tsx";
import { type Agent, Reply } from "./Reply.tsx";
import type { Node } from "./rows.ts";
import type { Live } from "./stream.ts";
import { UserRow } from "./UserRow.tsx";
import { Visual } from "./Visual.tsx";
import { isFileCard, visualCards } from "./visuals.ts";
import "./transcript.css";
import "./md.css";
import "./hljs.css";

export function Transcript({
  sessionId,
  nodes,
  live,
  agentOf,
  authorOf,
  onRegenerate,
  fork,
  foot,
}: {
  sessionId: string;
  nodes: Node[];
  live: ReadonlyMap<string, Live>;
  // the agent a reply names, by the row's agent id; null for one no
  // longer listed, and for a turn with no row yet the session's
  agentOf: (agentId: string | null) => Agent | null;
  // the name of a user row's author
  // the author's name, and the username for the link to their page
  authorOf: (userId: string | null) => {
    name: string;
    username: string | null;
  };
  // the last turn's Regenerate; absent while a send runs
  onRegenerate?: () => void;
  // Fork under every finished answer; absent in a run
  fork?: { agents: AgentSummary[]; agentId: string | null; onFork: OnFork };
  foot?: ComponentChildren;
}) {
  const rows = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement | null>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  const jumpHidden = useSignal(true);

  const footEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rows.current;
    const scroller = el ? scrollParent(el) : null;
    box.current = scroller;
    if (!el || !scroller) return;
    const onScroll = () => {
      const top = scroller.scrollTop;
      const height = scroller.scrollHeight;
      const gap = height - top - scroller.clientHeight;
      // a shrink clamps scrollTop without anyone scrolling, so a
      // decrease counts only while the height did not drop
      if (top < lastTop.current - 1 && height >= lastHeight.current) {
        stick.current = false;
      } else if (gap < 40) stick.current = true;
      lastTop.current = top;
      lastHeight.current = height;
      jumpHidden.value = stick.current || gap < 80;
    };
    // the foot grows with the draft and would cover the last rows: a
    // view that follows the end keeps following, one that let go
    // learns whether Jump applies
    const grown = new ResizeObserver(() => {
      if (stick.current) {
        scroller.scrollTop = scroller.scrollHeight;
        lastTop.current = scroller.scrollTop;
        lastHeight.current = scroller.scrollHeight;
      } else onScroll();
    });
    if (footEl.current) grown.observe(footEl.current);
    const onClick = (ev: MouseEvent) => void copyCode(ev);
    scroller.addEventListener("scroll", onScroll);
    el.addEventListener("click", onClick);
    return () => {
      grown.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      el.removeEventListener("click", onClick);
    };
  }, [jumpHidden]);

  const toEnd = () => {
    const scroller = box.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    lastTop.current = scroller.scrollTop;
    lastHeight.current = scroller.scrollHeight;
  };
  // a chat opens at its end
  useLayoutEffect(() => {
    stick.current = true;
    if (box.current === null && rows.current) {
      box.current = scrollParent(rows.current);
    }
    toEnd();
    jumpHidden.value = true;
  }, [sessionId, jumpHidden]);
  // a new row sticks the view to the bottom again
  useLayoutEffect(() => {
    stick.current = true;
  }, [nodes.length]);
  useLayoutEffect(() => {
    if (stick.current) toEnd();
  });

  return (
    <>
      <div class="transcript-rows" ref={rows}>
        <div class="transcript">
          {nodes.map((node, index) => {
            const last = index === nodes.length - 1;
            if (node.kind === "user") {
              return (
                <UserRow
                  key={node.message.id}
                  message={node.message}
                  author={authorOf(node.message.userId)}
                />
              );
            }
            return (
              <Reply
                key={`reply:${node.sendId}`}
                node={node}
                live={live}
                agent={agentOf(
                  node.message?.agentId ??
                    node.rows.find((row) => row.kind === "reply")?.agentId ??
                    null,
                )}
                onRegenerate={last ? onRegenerate : undefined}
                fork={fork}
                visuals={visualCards(node, visualPreviews.value).map((card) =>
                  isFileCard(card) ? (
                    <FileCard key={card.key} card={card} />
                  ) : (
                    <Visual key={card.key} card={card} />
                  ),
                )}
              />
            );
          })}
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
