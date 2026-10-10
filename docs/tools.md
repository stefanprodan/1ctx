# Tools

Governs `src/server/tools/`, `limits/`, `credentials/`, `skills/`, the
tool loop and policy in `src/server/runner/`, and the visual frame
(`GET /api/visual`, `tools/visual-theme.ts`, `tools/visual-scheme.ts`).
MCP tools are in `docs/mcp.md`, the bash tool and curl in
`docs/bash.md`, the system prompt's order in `docs/sessions.md`.

## Limits

- **`limits/defaults.ts` is the one table of limits.** Each has its
  default, floor, ceiling, unit and scope there. A row in `limits` is
  an admin's override alone, merged by `limits.current()`. Importers
  take types and defaults from `limits/index.ts`; `tools/` never
  imports `runner/`.
- **Only `sendsRunning`'s default moves, with the cores.** The area
  reads `limitDefinitions(cores)`; `LIMIT_DEFINITIONS` and
  `DEFAULT_LIMITS` are one core's, for floors, ceilings and tests.
  Current values, the rows' `default`, the drop of an override equal to
  the default and reset all use the computed one.
- **The send caps stay ordered.** `sendsPerUser <= sendsPerProject <=
  sendsRunning`; a write breaking it is a 400.
- **A change applies to the next send.** A send in flight keeps the
  caps and the offered set it started on; a send cap applies at the
  next admission.

## The tool loop

The tool loop is a send's rounds: the model calls tools, the server
runs them and sends the results back, until the model answers in
words. When a cap or a repeated call stops the tools, the loop ends
with the answer round, one more round that asks for the answer in
words.

- **Every cap is weighed before a round's calls launch.** Over a cap,
  the calls are recorded not run and the loop goes to the answer round
  with `tool_limit`, `token_limit` or `context_limit`. `maxBashCalls`
  is the exception: excess bash calls get an error result before queue
  or slot admission, and the loop goes on.
- **Spend counts cached tokens at a tenth.** A main round spends prompt
  less cached, plus cached / `CACHED_DIVISOR` rounded up, plus
  completion, or an estimate without usage.
- **Three equal call rounds in a row are refused once.** The calls are
  recorded not run with finish reason `tool_repeat` and the loop goes
  on. A second trip, or one with fewer than two rounds left, is the
  answer round with `tool_loop`.
- **The answer round keeps the cached prefix.** It sends the schemas
  unchanged and no `tool_choice`, since either change misses a
  server's cached prefix. The ask is a request-local user message after
  the last result: inside a tool result models called again, and Gemini
  refuses a request ending on a model turn.
- **An answer round that still calls is asked again, then bare.** On
  `openai-compatible` it first repeats the same request, cheap on a
  local server's cache. Then every wire gets one request without
  schemas; a call written there as text is dropped
  (`runner/text-calls.ts`) with finish reason `tool_text`.
- **Results that outgrow the window are cut largest first.** A cut
  keeps each result's `tail` (bash's exit and receipts, MCP's path
  lines) and adds a cut line, before storage. The room ends at
  `compactsAt()`; tails past it still go to the answer round with
  `context_limit`, since the reserve above holds them, and never fail
  the send.
- **The per-call cut keeps the tail too.** The registry cuts a body
  to `resultCut` before its `tail`, ending it with `resultCutLine()`
  when the line fits.
- **A round's calls run in parallel.** Each runs under the call
  timeout plus its tool's `graceMs` and the send's signal. Each call's
  end is one transaction, one revision, one envelope.
- **The server places every row.** Every message carries `send_id` and
  `round`, and a reply its `slot` (`work` or `answer`), written by the
  server. The client never infers placement from call arrays, finish
  reasons or the live map.
- **A tool row travels without its result.** Detail and envelopes carry
  `resultBytes`; the result route answers it cut at the display cap. The
  runner reads the full row from the store.
- **A command not found that names a tool gains a hint.**
  `tools/bash-hint.ts` adds a line saying to call it as a tool, or
  through `mcp_call` for a catalog MCP name.

## Errors

- **Words holding a call's input or a server's answer are a
  `ToolError`.** Its `logged` phrase is logged in their place. That
  covers names, paths, URLs, hosts, timezones the model wrote, and any
  text a remote server sent (MCP, search, webfetch). Other failures are
  fixed text with closed values.
- **`tool failed` names the tool by `toolLogName()`.** A built-in's
  name, `mcp:<server>` for an offered MCP tool, else `unknown`; never
  the name the model wrote.
- **A call the send's abort ended is `interrupted`, not failed.** The
  flag lives on `ToolResult` in memory and is never stored. The
  registry sets it on a throw once `ctx.signal` aborted (`failedCall`
  too), `runOne` on a throw of the port, bash when the abort ended it.
  A `delegate` call returns the child's own report instead. Only the
  code that ran the call says so, never the error text. An interrupted
  result logs no `tool failed`, since the send's end has the cause,
  and its row gets the cut text (`docs/sessions.md`); any other
  settled result is a completion, success or failure, and is kept.
  The cut kinds: read (`webfetch`, `websearch`, `datetime`, `skill`,
  `skill_file`, `mcp_describe`, `automation`), MCP read (the read side), `bash`,
  `delegate`, and write for every other name.

## The offered set

- **The offered set, the tools a send gives the model, is decided once
  per send in `tools/offer.ts`.** A model that accepts tools always gets
  `datetime` and `bash`. The session's disabled set is applied before
  schemas are built, and the agent page's tool count
  (`agents/directory.ts`) calls the same `offered()`.
- **`delegate` and a subagent's offer are `docs/subagents.md`'s.**
  The offer's scope says `delegate` for a main offer and `child` for a
  subagent's.
- **The admin's `web` row is one mode: `off`, `all` or `listed`.** Off
  and all keep the saved hosts. Web off (admin or chat) removes
  webfetch, websearch, bash's network and every credential. Websearch
  also needs a provider, null on a fresh instance. Webfetch checks every
  redirect against the listed origins. The send keeps its web snapshot.
- **Websearch needs no key.** Every provider answers keyless; a
  `search-<provider>.key` file only raises the rate.
- **Only the `visualize`, `email_user` and `automation` rows'
  `enabled` is read.** A patch moves the named tool's row alone.
  Webfetch's and websearch's `enabled` are ignored, and no route
  patches webfetch.
- **`needs_attention` is offered only in a run's attention step**, alone
  (`phase: "attention"` in `offer.ts`, `attentionOffered` on the
  policy), whose automation's mode is not off (`docs/automations.md`),
  never a chat, a run's main rounds or the memory phase. Any other name
  there is refused. Its one argument, `reason`, is one line, never a
  placeholder ("todo", "n/a", anything with "placeholder"); anything
  else is a tool error the model can correct. The description states
  `MAX_ATTENTION_REASON` characters, and a longer reason is cut to it,
  never refused: models miss a stated length. It holds the reason on the step's
  `AttentionHandle`, a later call replacing it, and answers `Marked.`,
  never that anyone was told. The automation's words on when follow its
  fixed description and end the step's ask, as the eval measured.
- **Each capability key drops exactly its part.** A capability is a part
  of the offer a chat or automation may switch off (`docs/sessions.md`).
  - `web`: as above.
  - `visualize`: drops the tool only; `open` and the skill read the
    admin's row alone.
  - `knowledge`: keeps `bash`, with no `/knowledge` mount
    (`docs/bash.md`), and drops the knowledge block.
  - `memory`: drops a chat's `memory_edit`; the note stays in the
    prompt. It means nothing in a run.
  - `email`: drops `email_user` only.
  - `automations`: drops a chat's `automation`. It means nothing in a
    run.
  - `mcp:<id>`, `skill:<id>`, `credential:<id>`: removed before the
    offer is built, so nothing of them reaches the send.
- **Each off key adds its line to the prompt.** The lines are
  `WEB_OFF_LINE`, `VISUALIZE_OFF_LINE`, `KNOWLEDGE_OFF_LINE`,
  `MEMORY_OFF_LINE`, `EMAIL_OFF_LINE`, `AUTOMATIONS_OFF_LINE` (a chat
  only), `mcpOffLine()` and
  `skillsOffLine()`, added only
  when the send offers tools (the knowledge line only with `bash`).
  They exist because history may still show what the switch turned
  off. `tools.capabilities()` lists the switchable keys: `web`
  unless the mode is off, `visualize` while its row is on, `email`
  while `email_user` is offered, `automations` while the `automation`
  row is on, and `knowledge` and `memory` always.
- **A delete forgets its key.** Deleting an MCP server, a skill or a
  credential forgets `mcp:`, `skill:` or `credential:<id>` in sessions
  and automations in the same transaction; deleting a repository forgets
  `repo:<id>` in its project's alone. Unassigning forgets nothing.

## Scheduled tasks

- **`automation` reads the chat's project's tasks, in a chat only.**
  Its main rounds, a summoned agent's and a chat's subagents are
  offered it; a run, a run's subagents (the scope's `origin`), the
  memory phase and the attention step never are, and a call whose
  actor is not a chat is refused. The row starts on; its switch is a
  card on the Config board (`AutomationTool.tsx`), saved on Save.
- **It grows by actions, never by tools.** `action` is an enum, and
  dispatch takes only its own list; each action names the fields it
  takes and refuses the rest. `list` is one line per task, never the
  instructions; `show` is every setting the task's page shows, then
  the instructions, the open alert and the last run's result.
- **It reads through `AutomationsPort`,** wired in `compose.ts`. An id
  of another project is not found. A switch is named only from the
  task's agent's servers and skills and its project's credentials and
  repositories; any other key is an item no longer available.
- **The last run's line is its send's.** `lastSend()`, then
  `runAnswer()` before its memory round: by status, cause and error,
  never the status alone, and a running run has no result yet. One that
  ended says whether it was flagged, from its session, since a
  dismissed alert leaves no other trace. Not flagged only where a mark
  could be (attention on, not cut by a restart), and not yet while a
  decider has still to read it.
- **Task text is quoted as data.** The instructions, the guidance and
  the answer go through the registry's `sanitize()` first (`asSent()`),
  then are fenced past any backticks left and labelled as the task's.
  An empty answer is no answer.
- **Every page fits the call's `resultCut`.** The instructions and the
  answer are cut at `FIELD_BYTES` of UTF-8 at a character boundary, and
  to what the cut leaves after the rest and the longest tail, so the
  fence closes and a note's offset is where the text ended. Reasons and
  errors are cut at `SHORT_BYTES`, a list line's at
  `LIST_REASON_BYTES`. A cut field is read on with `part`, an `offset`
  in characters and the `ref` its note gives: the edit revision or the
  run's id. A ref that no longer holds starts again at 0. `list` pages
  by task with `offset`.
- **The notes and links are the result's `tail`,** so a cut keeps them.
  Links are the app's own paths, which the renderer keeps.

## Email to users

- **`email_user` is offered with email set up and its row on.** The
  `email_user` tool row starts off; an admin turns it on (`PATCH
  /api/tools/email_user`, the SMTP page). While `email.enabled()` is
  false, the row off or the send's `email` key off, no send carries it,
  never the memory phase or the attention step.
- **It takes usernames, never an address.** `to` is 1 to `MAX_EMAIL_TO`
  usernames (an `@` in front is dropped, the name lowercased), `subject`
  one line of at most `MAX_EMAIL_SUBJECT` characters that `badSubject()`
  passes (no control or bidi character) and holding no `://`, `body`
  Markdown of at most `MAX_EMAIL_BODY` bytes. A recipient can open the
  session (its project, `access.visibleProjectIds()`), is enabled and
  past the forced password change, has a real address and turned email
  from agents on.
- **One refusal refuses the call.** Every user is checked before any
  row is written; the `ToolError` names each refused user and why, and
  nothing is queued, so the model calls again with the users it may
  email. It logs `email refused`.
- **The caps are constants, counted on the outbox.** `EMAILS_PER_SEND`
  per send (the session's `agent` rows since `sendStartedAt`, sends
  being serial per session) and `EMAILS_PER_PROJECT_DAY` per project
  over the last 24 hours. Over either, the call is an error the model
  reads, in the transaction that would queue it; the email is rendered
  before it, outside the write lock. The email itself is
  `docs/email.md`'s.

## Visuals

- **A visual is a sandboxed document:** HTML or SVG the `visualize` tool
  or bash's `open` draws in the chat. `GET /api/visual` serves a fixed
  shell with a CSP sandbox, an opaque origin, the saved resource hosts
  and `connect-src 'none'`. The iframe grants only `allow-scripts`. A
  MessageChannel port binds the parent to the first loaded document, so
  a later navigation loses it.
- **Drafts are inert; the final runs once.** A draft is the visual's
  HTML while it streams. Scripts run after the tool succeeds. Detail and
  envelopes replace a stored visual's `html` with its size; the visual
  route serves it.
- **The frame's theme is the chat's, not the system's.**
  `tools/visual-theme.ts` alone defines the frame's colours, as a
  separate document outside the client stylesheet rules.
  `tools/visual-scheme.ts` rewrites `prefers-color-scheme` and
  `matchMedia` to answer the chat's theme. The frame opens as
  `/api/visual?scheme=<light|dark>`, the page's scheme at mount, and
  the shell starts in it: a scheme unlike the iframe's paints an opaque
  canvas until the theme lands. The iframe stays hidden until its first
  load, since Safari paints an unloaded one white.
- **A whole page keeps a readable ground.** It loses its backdrop only
  when its text reads on the chat's ground at 4.5:1 (`visualGround()`).
  Otherwise, with no background of its own, it gets the
  `VISUAL_BACKDROPS` entry its text reads on and a browser's 8px body
  spacing, since the frame is see-through.
- **`skills/visualize/` follows the frame.** Change it in the same
  commit as the frame's names or the tool's contract.

## HTTP credentials

- **A credential is a row, its key an `http-` file.** It makes curl in
  bash send a header holding the key on requests under a URL prefix.
  Rows never hold a key; `readKey()` reads it at the moment of use and
  answers `missing` or `unusable` by `isUsableKey()`. Routes answer key
  state, never a value.
- **A credential's header is an RFC token, never a transport header
  or `proxy-*`** (`check.ts`, case folded). The template is printable
  ASCII with `{key}` exactly once.
- **A prefix is `normalizePrefix()`'s form.** Https, no userinfo, query
  or fragment, and accepted by just-bash's `validateAllowList`, since
  it becomes an allow-list entry.
- **A credential binds team projects only.** At most
  `MAX_CREDENTIALS_PER_PROJECT` per project, and never two whose
  prefixes overlap (`prefixesOverlap()`). Both are checked after the
  write, in the transaction that writes the links, so a 409 rolls it
  back.
- **A repository may read an `http-` key file without a credential**
  (`docs/repos.md`). Curl never signs with it, and the Key files list
  counts it as used.
- **A send offers its project's credentials only with network.** The
  offer is empty with web off, outside a team project and in the memory
  phase. A chat's `credential:<id>` moves one to `credentialsOff`, so
  curl refuses its prefix by name. How curl signs is in `docs/bash.md`.

## Skills

- **A skill is stored text and never runs.** It is an Agent Skills
  folder (a `SKILL.md` and its files) an agent loads through the `skill`
  tool. Ingest caps live in `skills/limits.ts`; text is cleaned and
  shown as text. Archives go through `lib/archive.ts`, duplicate member
  names refused.
- **A GitHub directory is never the repo's archive.** `skills/github.ts`
  pins the ref to a commit, lists the folder in one trees call and
  reads each file raw, so the caps count the skill, not the repo. That
  is two unauthenticated API calls per add or refresh (60 an hour per
  address). Symlinks and submodules are left out.
- **Refresh is explicit and never renames.** A source now holding
  another name is a 409. Deleting a skill an agent uses is a 409.
- **An agent's skills are one send snapshot.** The `skill` and
  `skill_file` tools come from the agent's skills, never from the
  `tools` rows. Their `name` is a plain string, no enum, matched exactly
  against the snapshot, and `skill_file` is offered only when it can
  answer. A call reads the current body by the snapshot's id and name.
- **The skills catalog shrinks its entries, never the snapshot.** In
  name order, it takes the first tier whose whole text fits
  `CATALOG_CAP`: name and description, then name and the description's
  first sentence cut at `MAX_CATALOG_LINE`, then the name alone (the
  lead then says to match a skill's name). The opening line after the
  lead says which. Tier 3 is the floor: printed over the cap, the offer
  logs `catalog over cap` with `kind` and `count`, never a name.
- **Skill usage is read from the calls.** A tool row holds only the
  result, so `skillLoads()` pairs each `skill` row with its call by
  position in the round, as the writer pairs them, and reads the name
  from the arguments. Usage routes answer through `lastDays()`.
