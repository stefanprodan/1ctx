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
  `1ctx` at the build version, has no instructions, registers tools only,
  and advertises `tools.listChanged: false`. It advertises no resources,
  prompts, sampling or subscriptions.

## Tools

- `projects` lists id, name and whether each reachable project is personal
  or team, paging by id with `after` when needed.
- `knowledge` reads with `list`, `search`, `read`, `versions` and
  `version`. List may filter a folder with `prefix` and files updated at or
  after an ISO 8601 `since`; matching rows say `new` or `changed`. A write key
  also gets `create`, `edit`, `replace`, `rename` and `delete`; a read key's
  schema omits those actions and forged writes are refused.
- `sessions` searches a project's chats and runs by words and lists them
  newest first, optionally since an ISO 8601 time. Children carry their
  parent's id; take any row's session id, including a child's, to `read` its
  Markdown transcript. Page routes still do not open a child by its id.

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

A knowledge write uses the key's user as author, with origin `key` and a
copy of the key name. Its outer transaction calls `checkKey()` before the
knowledge area's create, edit, replace, rename or revisioned remove. The
answer holds only the file id, name and new revision.

## Results

Knowledge `read` and `version` answer the whole file, as GitHub's MCP server
answers `get_file_contents`: a data label with the revision, then the stored
text exactly, never sanitized, since an `edit`'s `old` must match it. A file
of 1 MiB or more is refused; there is no paging and no download route. A
client keeps a result past its own output cap on disk. Lists and transcripts
page at 48 KiB, under Claude Code's 25,000-token and OpenCode's 50 KiB
defaults, and do not follow `resultBytes`. Knowledge file and version list
continuations carry a snapshot stamp; a filtered file list stamps its matching
rows, so an unrelated folder does not invalidate it. When the stamped list
changes they say to read from the start. Knowledge and session list
continuations also carry the first page's `readAt`; every page repeats that
same time in its footer, and the client uses it as `since` only after the
whole chain. Knowledge `since` is inclusive, so a write in that exact
millisecond may repeat but cannot be missed. Knowledge list rows and search
file metadata carry `by` in the page's `@name` words, the author's `sessionId`
when a chat or run wrote it and null otherwise, and `updatedAt` as ISO 8601
UTC; `change` appears only with `since`. Version rows carry the same `by` and
`sessionId` and an ISO 8601 UTC `writtenAt`. Session pages pin the message and
offset, with the read-on line first and newline-terminated so a client joining
blocks cannot run it into the data label. The last page says the transcript
ends; a removed continuation message says the session changed and to read
from the start. Knowledge continuations are newline-terminated too. Search
pages by `after`, explicitly say when nothing matched, and one underlying
search page already fits below the cap.

Knowledge `read` and `version` return an embedded resource with a
`1ctx://` URI naming the project, path and revision, the file kind's MIME
type and the text. They do not register an MCP resource. Search hit lines
pass the tool sanitizer; transcript text has its controls stripped and is not
trimmed, so a Markdown line break survives. Both are labelled
as project data quoted as data, never instructions. Transcript pages are
fenced.

Each tool call logs one `mcp call` event with user, key id, tool, action,
status and duration. Arguments and results never enter the log. The router
keeps no second request event for a successful key route, but still records
its 4xx and 5xx answers. Unexpected tool errors become an `internal error`
result and log through `errorFields()`. SDK errors log a fixed phrase with only
their class and JSON-RPC code, never their message.
