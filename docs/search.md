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

## Reads

- **Search streams, never indexes.** Each row query is its own
  statement, finalized at the end: a cached one left mid-step by an
  early stop refuses its next use. A text is read only once it fits the
  page's budget (`SEARCH_SCAN_BYTES`, `SESSION_SCAN_BYTES`), one file or
  session a page whatever its size; past it the page ends early with
  `next` set.
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
