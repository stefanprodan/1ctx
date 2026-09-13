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
import { Icon } from "../lib/icons.tsx";
import { scrollParent } from "../lib/scroll.ts";
import { copyCode } from "./copy.ts";
import { type Agent, Reply } from "./Reply.tsx";
import type { Node } from "./rows.ts";
import type { Live } from "./stream.ts";
import { UserRow } from "./UserRow.tsx";
import { sendCounters } from "./Work.model.ts";
import { Work } from "./Work.tsx";
import "./transcript.css";
import "./md.css";
import "./hljs.css";

export function Transcript({
  sessionId,
  nodes,
  live,
  agent,
  authorOf,
  foot,
}: {
  sessionId: string;
  nodes: Node[];
  live: ReadonlyMap<string, Live>;
  agent: Agent | null;
  // the name of a user row's author
  authorOf: (userId: string | null) => string;
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
          {nodes.map((node) => {
            if (node.kind === "user") {
              return (
                <UserRow
                  key={node.message.id}
                  message={node.message}
                  author={authorOf(node.message.userId)}
                />
              );
            }
            if (node.kind === "work") {
              return (
                <Work key={`work:${node.sendId}`} node={node} live={live} />
              );
            }
            const current = live.get(node.message.id) ?? null;
            return (
              <Reply
                key={node.message.id}
                message={node.message}
                live={current}
                think={
                  (current?.reasoning ?? "") !== "" ||
                  node.message.reasoning !== ""
                }
                counters={sendCounters(node.rows, node.send)}
                agent={agent}
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
