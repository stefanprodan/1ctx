# 1ctx

[![test](https://github.com/stefanprodan/1ctx/actions/workflows/test.yml/badge.svg)](https://github.com/stefanprodan/1ctx/actions/workflows/test.yml)

One continuous context for agents.

## Provision an instance

Stop the server, put the secret files in its secrets directory, then apply:

```sh
1ctx provision -f instance.yaml -f config/ --db ./1ctx.sqlite --secrets ./secrets
cat instance.yaml | 1ctx provision -f - --db ./1ctx.sqlite --secrets ./secrets
```

`-f` is repeatable. A directory contributes only its `.yaml` and `.yml`
files, sorted by name, without descending into subdirectories. Every
document has `apiVersion: config.1ctx.dev/v1`, a `kind`, `metadata.name`
and `spec`. Names identify objects; changing a name creates another object.

```yaml
apiVersion: config.1ctx.dev/v1
kind: User
metadata:
  name: admin
spec:
  role: admin
  tz: UTC
---
apiVersion: config.1ctx.dev/v1
kind: Project
metadata:
  name: example-team
spec:
  description: Shared work.
  members: [admin]
```

| Kind | Spec fields |
|---|---|
| `User` | `role` (required), `fullName`, `email`, `tz`, `about`, `disabled`, `passwordFrom`, `mustChangePassword` |
| `Project` | `description`, `members` (usernames); team projects only |
| `Provider` | `wire`, `baseUrl`, `keyFrom` |
| `Skill` | `url`, `fromIndex`, `path` (archives only) |
| `McpServer` | `url`, `keyFrom`, `read`, `write`, `instructionsOn`, `timeoutMs`, `readPatterns`, `writePatterns`, `excludedPatterns` |
| `Agent` | `provider`, `model`, `avatar`, `thinking`, `effort`, `prompt`, `skills`, `servers`, `mcpMode` |
| `Tool` | `enabled`; `provider` only for `websearch`, `hosts` only for `visualize` |

A new user requires `fullName`, `email`, `tz` and `passwordFrom`.
`passwordFrom` names a `user-<name>.key` file without the extension;
passwords and `mustChangePassword` are applied only at creation. The flag
defaults to true and `disabled` defaults to false. The first admin is
bootstrapped from `user-admin.key`; provision uses that file to sign in as
`admin` on every run, so it must match the account's current password.

A new provider requires `wire` and `baseUrl`; a new skill or MCP server
requires `url`; a new agent requires `provider` and `model`. `keyFrom`
names a `provider-` or `mcp-` key file without `.key`, or is null.
Providers and skill sources cannot be changed. Skills are fetched on
creation: `metadata.name` must match the fetched name, or select an entry
when `fromIndex: true`. MCP servers are discovered on creation and endpoint
changes. A new MCP server enables read and instructions, with write off,
no patterns and the default timeout unless set.

An agent references providers, skills and MCP servers by name. Its
`servers` entries have `name`, `read` (default true) and `write` (default
false); at least one side must be on. New agents default to `avatar: bot`,
`thinking: null`, `effort: null`, `mcpMode: auto`, an empty prompt and no
skills or servers. Model catalogs and per-wire effort levels are checked
at apply time.

Omitted fields are preserved on existing objects, except `User.disabled`,
which defaults to false. Supplied lists replace the whole membership;
omitted lists leave it alone. Objects absent from the input are not deleted.
Only `webfetch`, `websearch` and `visualize` are Tool objects. Limits and
automations are not provisioned.

All documents and references are validated offline before the instance is
changed. Apply runs in the table's kind order and stops on the first
refusal, keeping earlier writes. A project's description and each
membership change are separate route transactions. A skill-name mismatch
is detected after its create route has saved the fetched skill. Reapplying
is safe: each object reports `created`, `updated` or `unchanged`, followed
by counts. No secret values are printed.
