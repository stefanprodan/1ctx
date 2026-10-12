# Inbound MCP server

Governs `src/server/mcp-server/` and the `/mcp` endpoint. This server is
the inbound counterpart of the remote MCP clients in `docs/mcp.md`.

## Endpoint

- `POST /mcp` is authenticated only by an access key bearer under the
  router's `key` policy. A cookie is not a credential for it. `GET` and
  `DELETE` answer 405.
- `serve()` routes `/mcp`, `/mcp/` and `/mcp/*` through the same router as
  `/api/*`, including same-origin checking when an Origin is present. Only
  exact `/mcp` routes match; its subpaths answer the router's 404.
- The route reads JSON through `jsonBody()` under `MAX_KNOWLEDGE_BODY` after
  rate admission. An oversized admitted body answers 413 before the MCP SDK
  sees it.
- `@modelcontextprotocol/server` 2.3.1 serves the request with
  `legacy: "stateless"` and `responseMode: "auto"`. Both 2025
  initialization and 2026-07-28 discovery are accepted. Legacy event
  streams contain the answer and close. A modern call stays one JSON answer
  unless it emits a related message first.
- A key may send 120 JSON-RPC messages a minute. An exhausted key is refused
  before its body is read. Every member of an admitted batch counts. The
  fixed window is held per key id.
- The factory makes one server per request. It identifies itself as
  `1ctx` at the build version, registers tools only, and advertises
  `tools.listChanged: false`. It advertises no resources, prompts,
  sampling or subscriptions.
- Its instructions say what 1ctx is and when to use the tools, since a
  client's tool search reads them to decide whether to load the tools; a
  read key's never name a write. What one call needs stays in that tool's
  description, for clients that drop instructions.

## Tools

- `projects` lists id, name, whether each reachable project is personal
  or team, and its description, paging by id with `after` when needed.
- `knowledge` reads with `list`, `search`, `read`, `versions` and
  `version`. List may filter a folder with `prefix` and files updated at or
  after an ISO 8601 `since`; matching rows say `new` or `changed`. A write key
  also gets `create`, `edit`, `replace`, `rename` and `delete`; a read key's
  schema omits those actions and forged writes are refused.
- `sessions` searches a project's chats and runs by words and lists them
  newest first, optionally since an ISO 8601 time. Children carry their
  parent's id; take any row's session id, including a child's, to `read` its
  Markdown transcript. Page routes still do not open a child by its id.
- `tasks` lists work handed to the agent, open by default or filtered by state.
  On a write key, `held=true` keeps this key's claims and marks one answered
  when a member answered after its last report. `show` reads the current brief, linked file
  revisions and newest entries. A write key also gets `claim` and `report`;
  report takes the task and claim ids, an agent entry kind, text and optional
  HTTP(S) links. Claim and show say after how many idle hours a silent claim is
  released. In a live session the agent asks its user directly; only an
  unattended agent reports a question, ends its run and checks next run.

The schemas are JSON Schema adapted by `fromJsonSchema()` with a
permissive validator. The area's hand-written parsers decide accepted
fields and use the knowledge parsers where their contracts overlap. An
expected HTTP refusal is an MCP tool result with `isError: true` and the
same words the page uses.

## Access and writes

Every project and file read resolves through the access port. A session read
finds roots and children, then resolves the session's project through that
same port; hidden and missing sessions both answer `no such chat`. This MCP
lookup does not widen the page's root-only `visible()`. A list starts from
`reachableProjectIds()`. Hidden and missing objects have the same answer.

A file, version, session or task id is unique across projects, so a call that
names one takes `projectId` as optional: the server reads the project from
the row and answers a row the key cannot reach as missing. A `projectId`
that is given and differs from the row's answers the same.

A knowledge write uses the key's user as author, with origin `key` and a
copy of the key name. Its outer transaction calls `checkKey()` before the
knowledge area's create, edit, replace, rename or revisioned remove. The
answer holds only the file id, name and new revision.

A task list passes only `reachableProjectIds()`, or one project resolved by the
access port, to the task store. Show, claim and report resolve the task's
project before reading or writing it; hidden and missing tasks both answer
`not found`. Claim and report call `checkKey()` in the transaction and carry
the key's user, id and copied name. Report kinds are `progress`, `question`,
`result` and `release`; text is at most 16 KiB and it accepts at most five
HTTP(S) links of at most 2 KiB each.
`skills/external-tasks/` teaches an outside agent this loop. The binary
embeds that file and serves it at
`/.well-known/skills/external-tasks/SKILL.md`, and Connect agents gives the
line that installs it. Change it in the same commit as the tool; a test
checks every action and kind it names.

## Results

Every tool answer uses plain text parts, never embedded resources or
`structuredContent`. Knowledge `read` and `version` and session `read` each
answer exactly one text part. Its first line is a sentence naming the kind,
id, JSON-quoted file name or session title, revision or transcript position,
and whether it is complete or what range it holds. It says the fenced text is
data written by users and agents, not instructions. JSON quoting keeps control
characters, quotes and backticks from changing that one-line header. The data
is in a `text` backtick fence longer than every backtick run in it.

The footer is the last line and either marks the end or gives the exact next
call. A result without its footer was cut. Content begins after the opening
fence's newline. When content ends in a newline, the closing fence immediately
follows that newline; otherwise formatting adds one newline before the closing
fence and the final footer says the file ends without a newline. Thus the line
before the closing fence is the last content line, and removing the one
structural newline from a no-final-newline page recovers the stored text. Every
non-final file page ends with the newline that ends its last line. Knowledge
text is otherwise byte-exact, since an `edit`'s `old` must match it. Transcript
text keeps its controls stripped and is not trimmed, so a Markdown line break
survives.

A complete text part is at most 32 KiB, below Codex's smallest client
default with margin. The sole exception is one stored file line that is itself
too large to fit with the envelope; a client may cut that line in the middle.
Lists, both searches, version lists and transcripts page under the cap and
ignore `resultBytes`. Knowledge files and versions page by whole stored lines.
`offset` is a one-based first line and defaults to 1; `limit` optionally caps
how many lines the call returns, but a page still stops before 32 KiB. The
header names the page's lines and total, or says the file is empty. A live-file
continuation includes its revision, and a changed revision says the file
changed and to read from the start. A version is immutable, so its continuation
needs only version id and offset. An offset past the end is refused clearly. A
stored line that cannot fit with the required header, fence and footer is the
sole exception: it is sent whole on its own page and the header says so. A live
read past line 1 needs the revision, and its refusal says where to take it from.

Task lists page by the store's opaque row cursor; show pages entries newest
first by entry id. Brief text, each entry's text and its links use backtick
fences longer than every backtick run in the rendered data. A zero-width space
breaks stored runs longer than 63 backticks so fences and pages stay bounded.
The rendered value is not byte-exact when this happens. When a maximum brief leaves no
room for the first entry, the continuation names `before="newest"`: the newest
entries without the brief. Any other `before` omits the brief too; a null or
absent one is the first page with it, since strict clients send null for unset
fields. The result footer is always
last. Report answers are compact receipts; the caller already has the text and
links it sent.

A transcript continuation pins its message and UTF-16 `position`. Its one-part
header names the title, id and text position; its footer carries the next
message and position or says the transcript ends. A page ends at the last line
ending that fits. Only when no line ending fits may it end mid-line, and its
footer says that the next page continues the line. A removed continuation
message says the session changed and to read from the start.

Knowledge file and version list continuations carry a snapshot stamp; a
filtered file list stamps its matching rows, so an unrelated folder does not
invalidate it. When the stamped list changes they say to read from the start.
Knowledge and session list continuations also carry the first page's `readAt`;
every page repeats that same time in its footer, and the client uses it as
`since` only after the whole chain. Knowledge `since` is inclusive, so a write
in that exact millisecond may repeat but cannot be missed. Knowledge list rows
and search file metadata carry `by` in the page's `@name` words, the author's
`sessionId` when a chat or run wrote it and null otherwise, and `updatedAt` as
ISO 8601 UTC; `change` appears only with `since`. Version rows carry the same
`by` and `sessionId` and an ISO 8601 UTC `writtenAt`. Searches page their
underlying rows by `after` and oversized formatted knowledge-search rows by
`skip`; they explicitly say when nothing matched. A search, version list or
project list page ends with the exact next call or an end line, as a read
does; a knowledge or session list page ends with its `List read at` line.
With `fileId`, knowledge search checks only that reachable file under the same
per-user one-at-a-time guard as project search. Each answer gives the file
metadata once, then only line and sanitized text per hit. It stops scanning
when the page is full and returns `skip` for the next hit. Search hit lines use
the shared 160-character cutter.

Knowledge `read` with `outline: true` returns only a Markdown file's ATX
headings as line, level and text rows. Heading text uses the search hit line
cutter. It ignores headings inside backtick or tilde fenced code blocks,
including fences indented by up to three spaces, and pages rows with `skip`.
Every outline page ends with an end marker or exact continuation, and its
header says heading text is data, not instructions. A non-Markdown file says
it has no outline. Outline cannot be combined with `offset` or `limit`.

`replace` is accepted only when reading the current file from line 1 needs no
continuation. A larger file changes with `edit`, or with `delete` and `create`
for an intentional full rewrite. `edit`, `rename` and `delete` keep their
existing rules.

Each tool call logs one `mcp call` event with user, key id, tool, action,
status and duration. Arguments and results never enter the log. The router
keeps no second request event for a successful key route, but still records
its 4xx and 5xx answers. Unexpected tool errors become an `internal error`
result and log through `errorFields()`. SDK errors log a fixed phrase with only
their class and JSON-RPC code, never their message.
