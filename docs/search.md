# Search

Governs `shared/search.ts` (how a query matches, shared by the server
and the page's marks), knowledge search (`knowledge/search.ts`) and a
project's session search and list (`sessions/search.ts`).

## Matching

- **A query matches by words.** It splits on whitespace, a
  double-quoted run being one phrase (an unclosed quote runs to the
  end); a query with no word is a 400. A text or name matches when it
  holds every word in any case; its hit lines are those holding any,
  each cut round its first word. Knowledge search, session search and
  the page's marks share the one matcher.

## Ranking

- **Knowledge files come best first,** by BM25 over credited matches:
  Lucene's IDF `ln(1 + (N - df + 0.5)/(df + 0.5))`, k1 1.2, b 0.75,
  `N` the live files scanned, `df` those with a credited match, a
  file's length its bytes. The score sums the terms, times 1.5 when the
  name holds every term and 1.2 when it holds some; ties go in name
  order. Matching stays the filter, so ranking never drops a file.
- **A match is credited** (`creditedCount()`) when no letter, digit or
  combining mark touches it, a letter beside a digit counting as apart
  (`fts` in `fts5`), or the letters glued after it are exactly `s`,
  `es`, `d`, `ed`, `ing`, `er` or `ers`; a term of four or more
  characters ending in `e` also counts its stem followed by exactly
  `ing` (`releasing`). An edge is tested only where the term's own edge
  is a letter or digit, and a phrase only on its outer edges. A term in
  Han, Hiragana, Katakana, Hangul or Thai is credited everywhere. Any
  other match scores 0, so a file holding only inner matches (`claim` in
  `reclaim`) lists below every credited one.
- **A hit shows its best lines** (`bestLines()`): the most distinct
  terms held, then the most credited, then the earliest, in line order;
  `count` stays every line holding a term. A search with `fileId` keeps
  every hit line in order.

## Queue

- **One scan at a time, server-wide** (`lib/search-queue.ts`, made once
  in `compose.ts` and shared by knowledge and session search). The
  server has one thread, which also carries every chat's stream, so a
  scan yields to the event loop about every 8 ms through its step.
  Page searches go before `/mcp` ones, each in arrival order.
  Knowledge search with `fileId` is one file and never queues.
- **A waiter waits at most 5 s,** under Bun's 10 s idle timeout, so it
  gets an answer rather than a dropped connection, and at most 64
  wait. Past either it is `SearchBusy`: a 429 with `Retry-After` on the
  page, an error result saying when to retry over `/mcp`.
- **A caller that leaves stops its search.** The request's abort
  signal takes a waiting job out of the queue and stops a running scan
  at its next step. The page aborts a superseded query's request.
- **Access is checked again after the scan,** since a member may lose
  the project while waiting; the answer is the one a new request gets.

## Reads

- **A scan snapshots its order, then reads row by row.** Knowledge
  takes the file ids first, then reads each file's metadata and text
  in one query, so a hit shows one revision; a file gone meanwhile is
  skipped and never a name row. A page's rows are read again for their
  lines, with that read's metadata.
- **Knowledge search reads every live file on every page,** since the
  IDF needs the whole project; the project's byte cap bounds it.
  Name-only rows (the name holds every word, the text does not) come
  complete on the first page, and a file is never both. The cursor is
  the last row's score and name, opaque to the page and `/mcp`. A write
  between pages changes the scores, so a row may repeat or be skipped.
- **Session search reads a session only once it fits the page's
  budget** (`SESSION_SCAN_BYTES`), one session a page whatever its
  size; past it the page ends early with `next` set. It snapshots only
  the order (id and activity) past the cursor; each session's shown
  bytes, the budget check and its messages are one synchronous stretch
  at its turn, so a session the page never reaches is never summed.
- **Session search and list read every session of one project,**
  children (with their parent's id) and archived ones too, newest
  activity first over `sessions_activity`, with activity and id as the
  cursor. The caller checks the project.
- **Session search reads only what a transcript shows** (`SHOWN` in
  `sessions/export.ts`, which the export uses too): user messages and
  each send's answer before its memory phase. Never work text, a
  memory reply, a tool row or a summary, so never a packed blob, and
  every hit's message id is one a read can start from. A session
  matches when those messages together hold every word; at most
  `SEARCH_PAGE` hits a page.
