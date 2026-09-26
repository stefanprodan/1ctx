# Tools

Governs `src/server/tools/`, `limits/`, `credentials/`, `skills/`, the
tool loop and the policy in `src/server/runner/`, and the visual frame
(`GET /api/visual`, `tools/visual-theme.ts`, `tools/visual-scheme.ts`).
The Tools page is in `docs/views.md`, MCP tools in `docs/mcp.md`, bash's
mount in `docs/knowledge.md`.

## The loop

- **The tool loop is bounded, and the server places every row.** The
  loop caps (rounds, calls per round and per send, tool time, result
  bytes, `toolWorkTokens`) and the per-tool caps have their defaults,
  floors and ceilings in one table, `limits/defaults.ts`; an admin's
  override is a row in `limits`, `limits.current()` merges them, and
  `runner/limits.ts` and `tools/limits.ts` re-export the types and
  the defaults; `tools/` never imports `runner/`. The `chats` scope
  holds `archiveIdleDays` (1 to 180, default 30) and
  `archivedDeleteDays` (30 to 1825, default 365), neither with an off
  value; the chats sweep reads them at each pass. `maxBashCalls` refuses
  excess bash calls before queue or slot admission without ending the loop.
  A bash `command not found` for a name the send offers as a tool gains
  one line saying to call it as a tool, through `mcp_call` for a catalog
  MCP name (`tools/bash-hint.ts`).
- **Spend and thresholds.**
  Main rounds spend prompt less cached, a tenth of cached rounded up
  (`CACHED_DIVISOR` in `runner/round.ts`) and completion, or a request
  estimate without usage; `send end` logs it as `spent_tokens`. The
  tool-work threshold and the window threshold are checked before
  calls, forcing one answer round.
- **Repeats are refused once.**
  Three equal call rounds in a row are refused once, recorded not run
  with a result pointing at the earlier ones and finish reason
  `tool_repeat` ("repeat refused" in the fold), and the loop goes on; a
  second trip, or one with fewer than two rounds left, is the answer
  round with `tool_loop`.
- **The answer round keeps the cached prefix.**
  The answer round sends the schemas unchanged and no `tool_choice`,
  which would miss a server's cached prefix, and ends the request with
  the ask as a request-local user message after the last result, naming
  the reason (the models called again when it sat inside a tool
  result, and Gemini refuses a request ending on a model turn). A round
  that still calls is asked again: on `openai-compatible` first with the
  same request, which a local server's cached prefix answers in seconds,
  then on every wire once without schemas. A reply to that last request
  that writes a call as text (`runner/text-calls.ts`) keeps only the
  words before it, or a stop line, with finish reason `tool_text`.
  The crossing and answer rounds may pass the tool-work budget; summaries
  and memory have their own limits. Results that outgrow the remaining
  window are cut largest first before storage, keeping bash's exit and
  receipts and a cut line. The work row carries `tool_limit`, `token_limit`,
  `context_limit` or `tool_loop`; the answer keeps the provider's finish
  reason, except `tool_text`.
- **The server places every row.** A change on the Tools page applies to
  the next send, a run cap to the next admission; a send in flight
  keeps the caps and the set it started on. A round's calls run in
  parallel under the call timeout and the send's signal. A tool row is
  a message of kind `tool`, and each tool's end is one transaction,
  one revision, one envelope; only the reply text streams. Every
  message carries its `send_id` and `round`, and a reply row its
  `slot`, `work` or `answer`, written by the server: at the first call
  delta, or when the round ends. The client groups by send and slot and
  never infers placement
  from the call arrays, the finish reason or the live map. A tool row
  travels without its result; detail and envelopes carry `resultBytes`,
  and `GET /api/sessions/:id/messages/:messageId/result` answers it cut
  at the display cap. The runner reads the full row from the store.

## The offered set

- **The offered set is decided once per send.** The offered set is
  decided once per send in `runner/policy.ts` from the `tools` rows: a
  model that accepts tools always gets `datetime` and `bash` over the
  project's knowledge base. The admin's `web` row has one mode, `off`,
  `all` or `listed`, with plain hosts in `hosts`; off and all keep the
  saved list. The send's disabled set is applied before schemas are
  built: `web` off removes webfetch, websearch and bash's network.
  Websearch also needs a provider, null for None and on a fresh
  instance. Webfetch checks every redirect against the listed origins.
  The send keeps its web snapshot, domains included. Visualize keeps its
  separate switch and is unaffected. Only the `visualize` row's
  `enabled` is used; webfetch's and websearch's are ignored. `GET
  /api/projects/:id/agents` answers the tools capability's
  `capabilities()`: `web` unless the admin's mode is off, `visualize`
  while the Visuals row is on, and `memory` always, through a forward
  port.
- **Three keys stand alone in the set.**
  The prompt adds `WEB_OFF_LINE` after the date and before the MCP note
  exactly when the send's set holds `web` and it offers tools, regardless
  of the admin's mode. `visualize` is the second kind-alone key of the
  set (`VISUALIZE` in `shared/capabilities.ts`): `tools/offer.ts` drops
  the `visualize` tool and only the tool when the send's set holds it,
  `open` and the skill untouched, and the prompt adds the constant
  `VISUALIZE_OFF_LINE` after the web line by the same rule.
  `memory` (`MEMORY`) is the third: the offer drops the chat's
  `memory_edit` and the note stays in the prompt; `MEMORY_OFF_LINE`
  follows the visualize line when the set holds it, the send offers
  tools and it is a chat. An
  automation's set accepts it and it means nothing there. The memory
  phase offers the own-note `memory_edit` alone.
- **Search needs no key.**
  Every provider (exa, firecrawl, tavily) answers keyless, its
  `search-<provider>.key` file raises the rate, and the runner never holds
  a key.
- **The tools API.** The Web tab's API holds `access` (mode and
  domains), `search` (nullable provider and key presence), and
  `visualize` (its switch and hosts). The one `PATCH /api/tools/:name`
  descriptor accepts web mode/domains, websearch provider, or visualize
  enabled/hosts, never webfetch. The Built-in catalog is
  `tools/catalog.ts`, built by the send's own factories with sample
  inputs (name enums empty, `memory_edit` the chat's with the own-note
  text as its `variant`); the bash catalog sample uses all-mode words.

## Visuals

- **A visual is a sandboxed document.** The `visualize` web tool is on
  by default, with script, style and font hosts cdnjs.cloudflare.com,
  cdn.jsdelivr.net, unpkg.com and esm.sh; admins edit or empty the list.
  The tool description carries the saved hosts. Watchers receive draft
  `visual` frames by message and call index, in the send's sequence;
  the live snapshot carries `drafts`. Preview is inert; final runs
  scripts once, after the tool succeeds. `GET /api/visual` authenticates
  and serves the fixed shell with a CSP sandbox and opaque origin,
  the saved resource hosts and `connect-src 'none'`. The iframe grants
  only `allow-scripts`; the page's CSP meta sets `frame-src 'self'`.
  A MessageChannel port binds the parent to the first loaded document;
  a later navigation closes it. The frame stays 680px wide, scrolling
  on narrow screens and past 2,000px height. The stored fragment comes
  from `GET /api/sessions/:id/messages/:messageId/calls/:index/visual`
  after success; detail and envelopes replace its `html` with its size.
- **The frame's theme is the chat's.**
  `tools/visual-theme.ts` alone defines the frame's colours; its CSS is
  a separate document, outside the client stylesheet rules. The parent
  supplies the theme; the frame sets `data-theme` and dispatches
  `visualtheme`. The frame rewrites the visual's `prefers-color-scheme`
  queries and `matchMedia` to answer the chat's theme, not the system's
  (`tools/visual-scheme.ts`). A whole page (`<html>` or `<body>`) loses its
  plain backdrop, padding and margin only when its text reads on the
  chat's ground at 4.5:1, and the height counts the body's own spacing.
  Change `skills/visualize/` in the same commit as the frame's
  names or the tool's contract.

## HTTP credentials

- **An HTTP credential is a row, its key an `http-` file.**
  `credentials/` is the area after `projects/`: the tables `credentials`
  and `credential_projects` (links cascading with both sides), the
  store, the routes, the parsers and the pure rules in `check.ts`. The
  prefix is `normalizePrefix()`: https, no userinfo, query or fragment,
  at most `MAX_PREFIX`, stored as origin and path with the host's
  trailing dot dropped, and passing just-bash's `validateAllowList`.
  The header is an RFC token, never a transport header or `proxy-*`
  (case folded); the template is printable ASCII, at most
  `MAX_TEMPLATE`, with `{key}` exactly once. The key is `isUsableKey`,
  16 to 4,096 visible ASCII characters, read at the moment by
  `readKey()`: `missing` with no file, `unusable` when empty, too large
  or failing the rule. Methods default to GET and HEAD. A credential
  binds team projects only (a personal or unknown id is a 400), at most
  `MAX_CREDENTIALS_PER_PROJECT` to a project and never two whose
  prefixes overlap by `prefixesOverlap()`, both checked after the write
  in the transaction that writes the links (a 409 rolls it back).
  `GET`, `POST /api/credentials` and `PATCH`, `DELETE
  /api/credentials/:id` are `admin`; the list answers the `http-` key
  names with `usable` and each row's `key` state, never a value; PATCH
  takes any field but the name, a supplied `projectIds` replacing; a
  delete forgets `credential:<id>` in sessions and automations in the
  same transaction. `GET /api/projects/:id/agents` also answers
  `credentials`, the project's `{id, name}` in name
  order, for any agent, the same for members and admins.
- **A send signs bash's curl with its project's credentials.** The tools
  area's `offered()` takes the project's rows through a port to
  `credentials/`, in name order, as `credentials` (id, name, key name,
  prefix, header, template, methods), and those whose `credential:<id>`
  the send's set holds as `credentialsOff` (id, name, prefix); both are
  empty without network (the admin's mode or the chat's `web` off),
  outside a project, for a personal project and in the memory phase. The
  bash tool, at each command with network, checks each row by id (gone
  or unbound is `deleted`; a key name, prefix, header, template or
  methods differing from the send's is `changed`) and reads its key by
  the key name through `readKey()` (`missing`, `unusable`), so a
  replaced file applies to the next command; the keys ride in the
  command caps as `CommandCredential`s and nowhere else, and the tool
  scrubs its result of them again, the tail kept apart.
- **One fetch per URL, picked once.** `knowledge/credentials.ts` builds
  the `SecureFetch` the mount passes as just-bash's `fetch`:
  `commandFetch()` picks once, by `matchesAllowListEntry` on the URL
  curl asked for over every offered and off prefix, the web fetch
  (`webNetwork()`, all or listed as before, never a transform) or that
  credential's own `createSecureFetch`, its prefix the one allow-list
  entry carrying the header, its methods the allowed ones. So a signed
  redirect off the prefix, to http or to another credential is refused,
  an unsigned request redirected into a prefix stays unsigned, and a
  prefix is reached in listed mode without its host. An off, keyless,
  unusable, removed or changed credential, a method it lacks and a
  routing header the command sets (`ROUTING_HEADERS`: host, forwarded,
  the `x-forwarded-*`, URL rewrite and method override headers) are
  refused by its name before anything is sent, never the key file; the
  web fetch refuses `host`, `forwarded` and `x-forwarded-host`. Each
  fetch is made on first use.
- **A key never reaches the result.** Every key the command read, and
  its JSON-escaped forms (`escapedForms()`: `\/`, `\u` in either case),
  is replaced by `[credential <name>]` in the result as bytes (body,
  header values, status text, final URL), a header whose name holds one
  is dropped, `content-length` follows a changed body and a body grown
  past the cap is refused; an error is rebuilt from its first line, keys
  replaced, its name kept. The bash description adds `curl to <prefix,
  cut at 80> (<name>) is signed in; send no key.` per offered
  credential; the Tools catalog and the agent page count bash without
  any.

## Skills

- **A skill is stored text, never executable.** An admin adds a
  `SKILL.md` and its text files from a GitHub directory, an archive, a
  discovery index or a raw file through the compose fetcher. Tar, tar.gz
  and zip archives go through `lib/archive.ts`; duplicate member names
  are refused. An index digest is checked on add and refresh. Refresh is
  explicit and never renames the skill; deleting one an agent names is a
  409. Its delete forgets `skill:<skill id>` in sessions and automations
  in the same transaction, without revisions or envelopes; unassigning
  forgets nothing. Stored text is cleaned and shown as text, ingest caps
  live in `skills/limits.ts`, and nothing runs.
- **An agent's skills are one send snapshot.** Their capped catalog from
  `shared/skills.ts` sits in the prompt before the date line. The `skill`
  tool's name is an enum of that catalog, and `skill_file` is offered only
  when it can answer. These two tools come from skills, never the tools
  rows or the Tools page, a deliberate exception to the offered-set rule.
  A call reads the current body by the snapshot's id and name. After a
  summary, the user message names still-offered skills loaded before it.
  Before the catalog is built, `tools/offer.ts` removes the agent's skills
  whose `skill:<skill id>` is disabled, so the block, the enum and
  `skill_file` come from what is left, and all off means no block and no
  tool. The policy's `skillsOff` holds their sorted names, empty for a
  model without tools; `skillsOffLine()` names them after the MCP-off
  line, since a skill loaded before the flip left its body in history.
  `GET /api/projects/:id/agents` also answers `skills`, keyed by agent
  id, with `{id, name}` in name order from `skills/switchable.ts`, one
  read. Agents without skills have no entry.
