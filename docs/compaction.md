# Compaction

Governs the summary round and what a chat's history is after one:
`src/shared/compaction.ts`, `src/server/runner/tail.ts`,
`runner/compact.ts` and the summary request in `runner/context.ts`.
Sends, the writer and the queue are in `docs/sessions.md`.

## The summary and its tail

- **A summary round triggers at `compactsAt()`**
  (`shared/compaction.ts`) from an answer round's usage:
  `contextLength - min(contextReserve, contextLength / 4)`.
- **The summary round sends no tools and thinking off,** or the wire's
  least effort for a `thinkingRequired` model, since a provider refuses
  Off there. It carries `least` (`leastThinking()`), so a wire can tell
  it from a default that resolved to off.
- **The summary's `max_tokens` fits the window** less 256 and the
  request's size, min 128. The size is the last counted usage when it
  is inside the window, plus the estimate of rows written after that
  round's reply (a stopped turn's tool results, a later message), else
  `requestTokens()` of the whole request. An estimate gets +10%, at
  most what leaves a history at the threshold the whole
  `summaryMaxTokens` (the reserve less it and 256), never capped below
  half the reserve.
- **After a done summary, history is the summary, then its tail**
  (`runner/tail.ts`): the newest whole turns before the summary row,
  replayed as they were, then the rows after it. A turn is one send's
  rows but its summary row, so queued messages stay one turn and a call
  keeps its result. The walk goes newest first and stops at the first
  turn that does not fit, so a newest turn over the budget leaves none.
- **The tail budget** (`tailBudget()`) is the least of 20,000 tokens, a
  tenth of the window, and half of what `compactsAt()` leaves above the
  system prompt, the schemas and the summary, counted with
  `requestTokens()`; the last keeps a small window from compacting the
  turn after a summary. An unknown window gets no tail.
- **Nothing about the tail is stored.** The same rows, policy and
  window give the same tail every turn, so the cached prefix holds; a
  fork copies the rows and a regenerate drops the trailing summaries, so
  both fall back to an older summary and its tail on their own. The
  summary round reads the history as rendered, the previous summary and
  its tail included, so no turn is read twice.
- **The skills line scans from the previous summary's tail** and leaves
  out a skill whose result replays in the current tail; the uploads
  line counts only uploads before the tail.
- **Compact on demand is a send of kind `compact`** under the same
  lock. It needs a done answer since the last summary and a reply after
  the last user row, so a fork's unanswered messages are a 400.
