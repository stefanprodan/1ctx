// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The transcript and its scroll box. It follows the reply: only a
// scroll upwards lets go, since a programmatic scroll only ever moves
// down, and a new row sticks it to the bottom again. The Copy button
// of a code block arrives inside the server's HTML, so one delegated
// listener serves every block.

import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { type Agent, Reply } from "./Reply.tsx";
import type { Node } from "./rows.ts";
import { UserRow } from "./UserRow.tsx";
import "./transcript.css";
import "./md.css";
import "./hljs.css";

export function Transcript({
  sessionId,
  nodes,
  agent,
  authorOf,
}: {
  sessionId: string;
  nodes: Node[];
  agent: Agent | null;
  // the name of a user row's author
  authorOf: (userId: string | null) => string;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  const jumpHidden = useSignal(true);

  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      const height = el.scrollHeight;
      const gap = height - top - el.clientHeight;
      // a shrink clamps scrollTop without anyone scrolling, so a
      // decrease counts only while the height did not drop
      if (top < lastTop.current - 1 && height >= lastHeight.current) {
        stick.current = false;
      } else if (gap < 40) stick.current = true;
      lastTop.current = top;
      lastHeight.current = height;
      jumpHidden.value = stick.current || gap < 80;
    };
    const onClick = async (ev: MouseEvent) => {
      if (!(ev.target instanceof Element)) return;
      const b = ev.target.closest(".md-copy");
      if (!b) return;
      const code = b.closest(".md-block")?.querySelector(".md-block-code");
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        b.textContent = "Copied";
        setTimeout(() => {
          if (b.isConnected) b.textContent = "Copy";
        }, 1200);
      } catch {
        // no clipboard: the button stays as it is
      }
    };
    el.addEventListener("scroll", onScroll);
    el.addEventListener("click", onClick);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("click", onClick);
    };
  }, [jumpHidden]);

  // a chat opens at its end
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    lastHeight.current = el.scrollHeight;
    jumpHidden.value = true;
  }, [sessionId, jumpHidden]);
  // a new row sticks the view to the bottom again
  useLayoutEffect(() => {
    stick.current = true;
  }, [nodes.length]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  });

  return (
    <div class="transcript-scroll" ref={scroll}>
      <div class="transcript">
        {nodes.map((n) =>
          n.kind === "user" ? (
            <UserRow
              key={n.message.id}
              message={n.message}
              author={authorOf(n.message.userId)}
            />
          ) : (
            <Reply
              key={n.message.id}
              message={n.message}
              live={n.live}
              think={n.think}
              agent={agent}
            />
          ),
        )}
      </div>
      <button
        type="button"
        class="transcript-jump"
        hidden={jumpHidden.value}
        onClick={() => {
          stick.current = true;
          const el = scroll.current;
          if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        }}
      >
        Jump to latest
      </button>
    </div>
  );
}
