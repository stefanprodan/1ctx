# MCP

Governs `src/server/mcp/`, `shared/mcp.ts`, MCP tools in a send
(`tools/offer.ts`, `tools/builtin/mcp.ts`, `runner/policy.ts`) and the
kept results under `/mcp` (`tools/kept.ts`). The MCP admin page is in
`docs/views.md`.

- **An MCP server is rows, discovered through the official SDK.** The
  wire is `@modelcontextprotocol/client` v2 over Streamable HTTP in
  `auto` negotiation (the modern stateless era, or the legacy
  handshake); `mcp/client.ts` is its one importer, with one client per
  discovery or call, every response under one byte budget per client,
  the key from `mcp-<name>.key` sent as a bearer and scrubbed from every
  string the server says, every server string cut. An admin registers a
  server by name and URL (`isServerName`: the channel rule without the
  underscore, at most 24, since the wire name is `mcp__<server>__<tool>`
  inside the OpenAI rule) and picks the key from the `mcp-` files
  `secrets.list()` names.
- **Its tools are rows, refreshed without approval.** They are
  discovered on add, on an endpoint PATCH (url or keyName alone, the row
  kept on a 502), on Refresh, on a call that sees the server's
  fingerprint move and hourly, under the caps in `mcp/limits.ts`, with
  no approval step; a failed refresh keeps the last good list and
  records `refreshError`. The sides are the admin's patterns through
  `shared/mcp.ts` (`classify`: unusable, excluded, read, write, in that
  order) and never stored; `offered()` intersects the server's and the
  agent's switches. One refresh coordinator per `mcpArea`, never module
  state, closed in `shutdown()` after the runner; a delete aborts a
  discovery in flight and is a 409 while an agent references the server.
  Its delete forgets `mcp:<server id>` in sessions and automations in
  the same transaction, without revisions or envelopes; unassigning
  forgets nothing. Every server string is shown as text;
  `parametersHtml` is the one HTML, rendered on the server. The name
  never changes.
- **An agent's MCP tools are one send snapshot, decided in the policy.**
  An agent carries `servers` (a server id with `read` and `write`,
  saved with the agent row in one `transact()` through the mcp
  capability) and `mcpMode`. Before `mcp.offered()`, `tools/offer.ts`
  removes links whose `mcp:<server id>` is disabled; schemas, mode,
  catalog, instructions and digest all come from the remaining links.
  The offered set is the intersection of the
  server's and the agent's switches over the patterns, through
  `offeredServers()` in `shared/mcp.ts`, so the page's preview and the
  send agree: each schema lean (`wireSchema`, `wireDescription`, the
  description cut at 1,024) and the tools sorted by server then name
  after the built-ins and the skill tools, so the `tools` array is
  byte-stable across a session.
- **The mode picks schemas or a catalog.** `mcpMode` `all` puts every
  offered schema on the wire; `catalog` puts `mcp_describe` and
  `mcp_call` (`tools/builtin/mcp.ts`, the name an enum of the offered
  wire names) and one line per tool in the prompt, and the loop rewrites
  a call of an offered wire name to `mcp_call` before its row is
  written, so history never names a function the `tools` array lacks;
  `auto`, the default, is `all` while the lean schemas count at most
  `MCP_CATALOG_FROM_TOKENS` through `lib/tokens.ts`. In both modes the
  arguments are checked against the stored schema before anything goes
  out: `validateArguments` in `mcp/client.ts` names unknown and missing
  top-level properties, keeps the SDK validator's other words and lists
  the parameters, and a schema the validator cannot compile lets the
  call through. A call runs through the registry under the wire name in
  both modes, under the server's `timeoutMs` or the limits' call
  timeout, one client per call over the snapshot's URL and key name; the
  row is a tool row like any other. Access to an agent grants its MCP
  tools.
- **The system prompt's order.** The system prompt is the agent's
  prompt, the project and user or automation part, the skills catalog,
  the MCP catalog, the servers' instructions as the delimited
  `<mcp_instructions>` block (capped, tags neutered, off per server),
  the project memory block (a chat's snapshot, a run's live note), the
  automation memory block, the knowledge block, the date line, the
  chat's web-off line when applicable, the visualize-off line when
  applicable, the memory-off line when applicable, the MCP-off line when
  applicable, the skills-off line when applicable, and last the change
  note. The policy's `mcpOff` holds the sorted names of disabled linked
  servers with otherwise-offered tools, empty for a model without tools;
  `mcpOffLine()` names them. `GET /api/projects/:id/agents` also answers
  `servers`, keyed by agent id, with `{id, name, tools}` from
  `mcp.switchableBy()` in name order, over one read of the catalogs,
  without prompt caps or hashing. Agents with no switchable servers have
  no entry; members and admins get the same map.
- **A change in the offer is a note, not a new prefix.** A send records
  a content-addressed digest of what it offered from MCP (`mcp_digests`,
  `sends.mcp`, null for a compact send, swept with the logins);
  `startSend` compares it with the session's previous send (a
  regenerated turn against the turn before it), and a difference is the
  note after the date line naming added, removed and changed wire names,
  so the stable prefix stays cacheable. A running send never changes its
  set.
- **An MCP result the context cannot hold is kept under `/mcp`.** In a
  send that offers bash, `tools/kept.ts` shapes each MCP answer from the
  scrubbed parts `mcp.call()` returns beside the flattened text: text
  over `resultCut` is kept whole as `result.json` (an object or array)
  or `result.txt`, never YAML by guess, and the context gets its start,
  cut at a line, then `whole result: <path>, N lines, S: query it with
  ...`; an embedded resource that is text under the cut is inlined and
  not kept, and every other one with text or a blob is a file named from
  its URI's last segment (made safe, `resource-<n>` when that leaves
  nothing, `-2` for a repeat), with a `saved: <path>` line. The path
  lines are the result's `tail`, so the registry, `cutResult` and
  `fitResults` keep them. A call keeps at most `MAX_KEPT_PER_CALL` files
  (one slot for the whole result) and nothing past the chat's
  `mcpKeptBytes` or `mcpKeptFiles`, this send's files counted, saying
  so; saved lines longer than half the cut become one line naming the
  folder.
- **Kept files are rows, trimmed under the lock.** Files are rows of
  `mcp_kept_files`, written by the writer's `finishTool` in the row's
  transaction, cascading with the message, copied by fork; each call's
  folder is `/mcp/<NNNN>-<tool>/`, numbered from `sessions.mcp_folders`,
  never reused. `prepareSend` trims the oldest folders to `mcpKeptBytes`
  and `mcpKeptFiles` (knowledge scope) through `knowledge.startKept()`
  under the runner's lock, so no command loses a file while it reads; a
  regenerate's files, on the rows it is about to delete, count for
  nothing. The mount adds each as a lazy file (`writeFileLazy`), sized
  into `mountBytes` and `ioBytes` (four reads of the largest); `/mcp` is
  never committed, an added or removed name under it gives a discard
  notice found from `getAllPaths()` alone (a `stat` would load every
  file), a changed file is dropped without one, and `open` and the saved
  cwd accept it. `prepareSend` calls `startKept` before `startSend`. A
  kept name is server text and never reaches a log field.
