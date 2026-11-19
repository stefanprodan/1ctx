# Secrets

Governs `src/server/secrets/` and the `SECRET_KINDS` of
`shared/words.ts`: the secret files, their kinds, their reads and the
log scrub.

- **A secrets reader is bound to one kind.** One bare value per
  `<kind>-<name>.key`, the kind from `SECRET_KINDS`, the name by
  `isSecretName`; `read()` and `list()` refuse a name of
  another kind. `openshell-` holds the sandbox gateway's TLS PEMs
  (`docs/sandbox.md`). `compose.ts` binds each area's reader; only
  provision, the Monitor's key checks (`overview/`) and the log
  scrubber read by kind.
- **`read()` sizes a file before reading it.** Null for an absent or
  empty file, a non-regular file after links (a FIFO could block) and
  one past `maxBytes`; `main.ts` caps `http-` files.
- **A value is never logged, returned by a route or stored.** Routes
  list names alone. Provider, search, MCP, `http-`, `email-` and
  `openshell-` values are scrubbed from logs, the kinds in `SCRUB_KINDS`
  in `compose.ts`.
- **The gateway's own `tls/` folder holds key material outside the
  secrets folder:** its CA key and the client key the `openshell-` files
  copy, in `.preview/openshell/tls` and on staging
  `~/.1ctx/openshell/tls`, owner-only (`docs/deploy.md`).
- **The sandbox shell copies `http-` keys into the gateway.** Each
  credential a listed-mode send attaches is an OpenShell provider
  holding its key in the gateway's encrypted provider store, the one
  copy of a key outside the secret files. 1ctx keeps only its hash in
  memory, to tell a rotation; the provider is deleted once no sandbox
  uses it, and the start sweep deletes any left (`docs/sandbox.md`).
