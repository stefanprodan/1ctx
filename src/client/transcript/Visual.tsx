// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import {
  cancelVisual,
  loadToolResult,
  loadVisual,
  toolResults,
  toolVisuals,
} from "../data/session-values.ts";
import { readTheme, VisualPlayer, type VisualStatus } from "./Visual.model.ts";
import type { VisualCard } from "./visuals.ts";
import "./visual.css";

export function Visual({ card }: { card: VisualCard }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const player = useRef<VisualPlayer | null>(null);
  const status = useSignal<VisualStatus>({
    state: "loading",
    height: 80,
    error: null,
  });
  const stored = toolVisuals.value.get(card.key);
  const result = card.result;
  const failed =
    result !== null &&
    result.status !== "done" &&
    result.status !== "streaming";
  const failure = result ? toolResults.value.get(result.id) : undefined;
  const error =
    card.preview?.error ??
    (failed
      ? failure?.status === "done"
        ? failure.content
        : failure?.status === "failed"
          ? failure.error
          : null
      : stored?.status === "failed"
        ? stored.error
        : null);

  useLayoutEffect(() => {
    const frame = iframe.current;
    if (!frame) return;
    const model = new VisualPlayer({
      post: (message) => port.current?.postMessage(message),
      close: () => {
        if (port.current) {
          port.current.onmessage = null;
          port.current.close();
          port.current = null;
        }
      },
      now: () => performance.now(),
      schedule: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
      changed: (next) => {
        status.value = next;
      },
    });
    player.current = model;
    const theme = () => {
      const css = getComputedStyle(document.documentElement);
      model.setTheme(
        readTheme(css.colorScheme, (name) => css.getPropertyValue(name)),
      );
    };
    theme();
    const mutations = new MutationObserver(theme);
    mutations.observe(document.documentElement, { attributes: true });
    mutations.observe(document.body, { attributes: true });
    mutations.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", theme);
    window.addEventListener("resize", theme);
    document.addEventListener("load", theme, true);
    return () => {
      model.dispose();
      player.current = null;
      mutations.disconnect();
      media.removeEventListener("change", theme);
      window.removeEventListener("resize", theme);
      document.removeEventListener("load", theme, true);
      cancelVisual(card.messageId, card.callIndex);
    };
  }, [card.messageId, card.callIndex, status]);

  useEffect(() => {
    if (result?.status === "done" && stored === undefined) {
      void loadVisual(card.messageId, card.callIndex);
    }
    if (failed && result && failure === undefined)
      void loadToolResult(result.id);
  }, [result, stored, failed, failure, card.messageId, card.callIndex]);

  useLayoutEffect(() => {
    const model = player.current;
    if (!model) return;
    if (error) {
      model.fail(
        error,
        card.preview?.phase === "failed" ? card.preview.html : undefined,
      );
    } else if (failed || card.preview?.phase === "waiting") {
      model.wait();
      if (stored?.status === "done" && !failed) model.draw(stored.html, true);
    } else if (stored?.status === "done") {
      model.draw(stored.html, true);
    } else if (card.preview?.phase === "draft") {
      model.draw(card.preview.html);
    }
  }, [card.preview, stored, failed, error]);

  const current = status.value;
  const drawing = !["finalized", "failed", "navigated"].includes(current.state);
  return (
    <div
      class={`visual-card${current.state === "failed" ? " visual-failed" : ""}`}
      data-visual={card.key}
      data-state={current.state}
    >
      <div class="visual-head">
        <span class="visual-title">
          {stored?.status === "done" ? stored.title : card.title}
        </span>
        {drawing && (
          <span class="visual-state">
            {failed ? "Loading failure" : "Drawing"}
          </span>
        )}
      </div>
      <div class="visual-scroll">
        {current.state !== "navigated" && (
          <iframe
            ref={iframe}
            class="visual-frame"
            title={card.title}
            src="/api/visual"
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            width={680}
            height={current.height}
            onLoad={() => {
              const model = player.current;
              if (!model?.load()) return;
              const channel = new MessageChannel();
              port.current = channel.port1;
              channel.port1.onmessage = (event) =>
                model.receive(event.data, true);
              channel.port1.start();
              iframe.current?.contentWindow?.postMessage(
                { type: "connect" },
                "*",
                [channel.port2],
              );
            }}
          />
        )}
      </div>
      {current.error !== null && (
        <div class="visual-error">{current.error}</div>
      )}
    </div>
  );
}
