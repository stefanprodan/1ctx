// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The lines a channel adds to the transcript, each one line and never
// a card: the quote that opens an answer, a pending turn under its
// post, the mark where agents stop reading, the pages above or between,
// and the stop of one running turn. Colour only where the reader acts.

import type {
  PendingTurn,
  RunPost,
  TraceCall,
} from "../../shared/contracts/session.ts";
import { Icon } from "../lib/icons.tsx";
import { useAction } from "../lib/save.ts";
import {
  pendingWords,
  type Quote,
  runOfLine,
  runTraceWords,
  traceLine,
} from "./Channel.model.ts";
import { folds } from "./fold.ts";
import "./channel.css";

const { useFoldOpen } = folds();

export function QuoteLine({
  quote,
  author,
  onOpen,
}: {
  quote: Quote;
  author: string;
  onOpen: () => void;
}) {
  const title = `${author}: ${quote.line}`;
  return (
    <button
      type="button"
      class="channel-quote"
      title={title}
      aria-label={`Go to the post. ${title}`}
      onClick={onOpen}
    >
      <Icon name="chat" size={12} class="channel-quote-icon" />
      <span class="channel-quote-author">{author}</span>
      <span class="channel-quote-text cut">{quote.line}</span>
    </button>
  );
}

export function PendingLine({
  turn,
  agent,
  onCancel,
}: {
  turn: PendingTurn;
  agent: string;
  // absent for a viewer who is neither its summoner nor an admin
  onCancel?: () => Promise<void>;
}) {
  const action = useAction();
  const words = pendingWords(agent, turn.reason);
  const failure = action.failure.value;
  return (
    <div class="channel-pending">
      <Icon name="clock" size={13} class="channel-pending-icon" />
      <span class="channel-pending-words cut" title={words}>
        {words}
      </span>
      {failure !== null && (
        <span class="channel-failed cut" title={failure}>
          {failure}
        </span>
      )}
      {onCancel !== undefined && (
        <button
          type="button"
          class="btn-text channel-act"
          disabled={action.busy.value}
          onClick={() => void action.run(onCancel)}
        >
          {turn.reason === null ? "Cancel" : "Dismiss"}
        </button>
      )}
    </div>
  );
}

export function ContextLine() {
  return (
    <div class="channel-context">
      <span class="channel-context-rule" aria-hidden="true" />
      <span>Context starts here</span>
      <span class="channel-context-rule" aria-hidden="true" />
    </div>
  );
}

// the page above the first row, or the posts a window leaves between
export function MoreLine({
  words,
  loading,
  failure,
  onMore,
}: {
  words: string;
  loading: boolean;
  failure: string | null;
  onMore: () => void;
}) {
  return (
    <div class="channel-more">
      {failure !== null && (
        <span class="channel-failed cut" title={failure}>
          {failure}
        </span>
      )}
      {loading ? (
        <span class="channel-more-busy">Loading</span>
      ) : (
        <button type="button" class="btn-text channel-act" onClick={onMore}>
          {failure === null ? words : "Try again"}
        </button>
      )}
    </div>
  );
}

export function StopTurn({ onStop }: { onStop: () => Promise<void> }) {
  const action = useAction();
  const failure = action.failure.value;
  return (
    <span class="channel-stop">
      {failure !== null && (
        <span class="channel-failed cut" title={failure}>
          {failure}
        </span>
      )}
      <button
        type="button"
        class="transcript-act"
        title="Stop"
        aria-label="Stop"
        disabled={action.busy.value}
        onClick={() => void action.run(onStop)}
      >
        <Icon name="stop" size={12} />
      </button>
    </span>
  );
}

// what the channel's page passes the transcript
export type ChannelView = {
  // who reads it: the summoner and an admin stop and cancel a turn
  viewer: { id: string; admin: boolean } | null;
  pending: readonly PendingTurn[];
  // the dropped mark, null until the stream first passed its budget
  droppedSeq: number | null;
  // a post's seq lies in the pages held
  shown: (seq: number) => boolean;
  agentName: (agentId: string) => string;
  onStop: (sendId: string) => Promise<void>;
  onCancel: (turnId: string) => Promise<void>;
  // a quote's post, read around its seq first when not held
  onQuote: (post: { id: string; seq: number }) => Promise<void>;
  older: {
    more: boolean;
    loading: boolean;
    failure: string | null;
    onOlder: () => void;
  };
  // the posts between a window and the newest pages, before the first
  // of those
  gap: { before: number; onGap: () => Promise<void> } | null;
  // the post a quote asked for, scrolled to once drawn
  focus: string | null;
  onFocused: () => void;
};

// a run's posted answer: its calls in the turn's fold, one line each,
// with nothing behind them, since no result is posted
export function RunTrace({
  postId,
  calls,
}: {
  postId: string;
  calls: readonly TraceCall[];
}) {
  const { open, onToggle } = useFoldOpen(postId);
  return (
    <details
      class={`transcript-fold transcript-work${
        open ? " transcript-fold-open" : ""
      }`}
      open={open}
      onToggle={onToggle}
    >
      <summary class="transcript-fold-head">
        <Icon name="chevron-right" size={13} class="transcript-fold-chevron" />
        <span>{runTraceWords(calls)}</span>
      </summary>
      <div class="transcript-work-rounds">
        {calls.map((call, index) => {
          const line = traceLine(call);
          return (
            // a trace never reorders, so its place is its key
            <div key={index} class="channel-call">
              {line.server !== null && (
                <span class="transcript-tool-server">{line.server}</span>
              )}
              <span class="transcript-tool-name">{line.tool}</span>
              {line.argument !== "" && (
                <span
                  class="transcript-tool-argument cut"
                  title={line.argument}
                >
                  {line.argument}
                </span>
              )}
              {line.state !== "" && (
                <span
                  class={`transcript-tool-state${
                    line.failed ? " transcript-tool-failed" : ""
                  }`}
                >
                  {line.state}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

// the actions line's "Run of <automation>", a link while the run is kept
export function RunOf({ run }: { run: RunPost }) {
  const line = runOfLine(run);
  if (line === null) return null;
  return line.href === null ? (
    <span class="channel-run cut" title={line.words}>
      {line.words}
    </span>
  ) : (
    <a
      class="channel-run channel-run-link cut"
      href={line.href}
      title={line.words}
    >
      {line.words}
    </a>
  );
}
