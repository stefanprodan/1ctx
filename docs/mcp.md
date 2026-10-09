# MCP

Governs `src/server/mcp/`, `shared/mcp.ts`, `shared/mcp-catalog.ts`,
MCP tools in a send (`tools/offer.ts`, `tools/builtin/mcp.ts`,
`runner/policy.ts`) and how an MCP result becomes files
(`tools/kept.ts`). Kept files' storage and mount are in `docs/bash.md`.

An MCP server is a remote tool server an admin adds by URL; its tools
reach the model in the sends of agents linked to it.

## Servers

- **`mcp/client.ts` and `mcp/validate.ts` alone import the SDK.** The
  wire is `@modelcontextprotocol/client` v2 over Streamable HTTP,
  `auto` negotiation. One client per discovery or call, every response
  under one byte budget per client.
- **The key is a bearer and never comes back.** It is read from
  `mcp-<name>.key` and scrubbed from every string the server sends.
  Every server string is cut and shown as text; `parametersHtml` is the
  one HTML, rendered on the server.
- **A server name is at most 24 and never changes.** The wire name is
  `mcp__<server>__<tool>` and must fit the OpenAI function name rule.
- **Tools are rows, refreshed without approval.** Discovery runs on add,
  on a PATCH of url or keyName (the row kept on a 502), on Refresh,
  hourly, and on a call that sees the server's fingerprint (a hash of
  its name, version and instructions) move. A failed refresh keeps the
  last good list and records `refreshError`.
- **One refresh coordinator per `mcpArea`, never module state.** It is
  closed in `shutdown()` after the runner, since ending calls may still
  ask for a refresh. A delete aborts a discovery in flight.
- **A server an agent references cannot be deleted.** The delete is a
  409.
- **A tool's side, read or write, is never stored.** `classify()` in
  `shared/mcp.ts` derives it from the admin's patterns (unusable,
  excluded, read, write, in that order), so a pattern change applies at
  once.
- **Usage counts tool rows by wire name.** A catalog call counts under
  its tool, and a deleted server's calls stay under its name.

## MCP tools in a send

- **An agent's MCP tools are one send snapshot.** An agent links
  servers with `read` and `write`; `read` is always on, since write
  alone is refused by the parser, the store and provisioning. Access to
  an agent grants its MCP tools.
- **The page and the send compute the same set.** The offer is the
  server's and the agent's switches over the patterns, through
  `offeredServers()` in `shared/mcp.ts`. Never compute it a second way.
- **The `tools` array is byte-stable across a session.** Schemas are
  lean (`wireSchema`, `wireDescription`, description cut at 1,024),
  sorted by server then name, after the built-ins and the skill tools.
- **A cut text ends in `…`** inside its cap, so the model never reads it
  as whole: a wire description and the catalog's sentence. The stored
  cap at discovery stays bare.
- **`mcpMode` picks schemas or a catalog.** `all` puts every schema on
  the wire. `catalog` offers `mcp_describe` and `mcp_call` and one
  prompt line per tool, neither tool when no offered server has one.
  `auto` is `all` while the schemas count at most
  `MCP_CATALOG_FROM_TOKENS`.
- **The catalog never narrows the snapshot.** Every offered server keeps
  its instructions, digest and tools in both modes, so the catalog cap
  is never an access cap. The snapshot's own caps still apply in both
  modes: past `MAX_SCHEMAS_BYTES` a server is left out whole, past
  `MAX_INSTRUCTIONS_BLOCK` it keeps its tools and loses its instructions.
- **The catalog shrinks its lines, never its tools.** It takes the
  first tier whose whole text (lead, opening line, every
  `<server> (N tools):` header, every line, closing tag) fits
  `MAX_CATALOG`: `name(args): sentence`, then `name(args)`, then
  `name`. The opening line after the lead says which. Arguments are
  dropped last, since they stop guessed calls. The tier is a pure
  function of the snapshot, so the prompt stays byte-stable.
- **Tier 3 is the floor.** Past it the catalog is printed over the cap
  and the offer logs `catalog over cap` with `kind` and `count`, never a
  name.
- **A catalog line is `name(args): sentence`** at tier 1, so a model
  that skips `mcp_describe` does not guess names. The args are the lean
  schema's top-level names, then any `required` name `properties`
  lacks, an optional one marked `?`; types stay with `mcp_describe`. No
  list when the top level has `anyOf`, `oneOf`, `allOf` or a kept
  `$ref`, or a name is outside `[A-Za-z0-9_.$-]`, since it would lie or
  break the line. Only the sentence is cut, at `MAX_CATALOG_LINE`; it
  reads past `e.g.` and `i.e.`.
- **`mcp_describe` and `mcp_call` take `name` as a plain string.** No
  enum, since the catalog lists the names; a name outside the snapshot
  is refused, matched exactly. `mcp_describe` answers the description,
  then the schema as minified JSON, since it stays in history.
- **History never names a function the `tools` array lacks.** In catalog
  mode the tool loop rewrites a call of an offered wire name to
  `mcp_call` before its row is written.
- **Arguments are checked before anything goes out.**
  `validateArguments` checks them against the stored schema in both
  modes (`mcp/validate.ts`). A schema the validator cannot compile lets
  the call through. Validators are kept by the schema's text, at most
  `MAX_VALIDATORS`, since Ajv keeps every schema object it compiles and
  each send parses its schemas afresh.
- **A call runs under the snapshot.** One client per call over the
  snapshot's URL and key name, under the server's `timeoutMs` or the
  call timeout.
- **A change in the offer is a note, not a new prefix.** A send stores
  a digest of its MCP offer (`sends.mcp`, null for a compact send).
  `startSend` compares it with the session's previous send of the same
  agent, so agents taking turns see no change. A difference is the
  change note at the end of the prompt, so the prefix stays cacheable.

## Results under /mcp

- **A result the context cannot hold is kept whole,** as files under
  `/mcp` that bash can read: a kept file. Only in a send that offers
  bash. Text over `resultCut` is kept as `result.json` (an object or
  array) or `result.txt`, never YAML by guess. The context gets its
  start, cut at a line, and a path line saying how to query it.
- **An embedded resource is inlined or kept, never both.** Text under
  the cut is inlined. Anything else is a file named from its URI's last
  segment, made safe.
- **Path lines are the result's `tail`.** So the tool registry,
  `cutResult` and `fitResults` keep them.
- **A call keeps at most `MAX_KEPT_PER_CALL` files.** Nothing past the
  chat's `mcpKeptBytes` or `mcpKeptFiles`, this send's files counted,
  and the result says so.
- **A kept name is server text.** It never reaches a log field.
