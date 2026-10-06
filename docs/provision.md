# Provision

Governs `src/server/provision/`: `1ctx provision` and the server's
`--provision`.

Provisioning applies YAML documents, one object each (a `kind` from
`KINDS`: users, mail, projects, credentials, repositories, providers,
deciders, skills, MCP servers, agents, tools), to an instance's database, creating or updating
what they name.

## Running it

- **One routine serves both entry points.** `provisionPaths()` in
  `run.ts` validates offline, then applies through the composed router.
  Validation migrates and reads the database file itself inside a
  transaction it always rolls back, never a copy: startup memory must
  not grow with the database. Its migrations run with foreign keys
  off, so a migration never relies on `on delete cascade`, and a
  pending rebuild runs twice at start. The app is composed with
  `activate: false`: no listener, scheduler, session repair, sweep or
  MCP refresh runs.
- **Provisioning needs the database to itself.** It refuses a file
  another process holds, so stop the server first.
- **Apply signs in as `admin` with `user-admin.key`.** It bootstraps
  that admin first when the database has none, and reports it apart
  from the counted objects.
- **`--provision` runs at every server start, before the database
  opens.** Docker Compose and Kubernetes restart the server to apply a
  change. A one-shot or init container would fail on `up -d` and on an
  upgrade, since the old server still holds the database.
- **At start a missing path or a folder without YAML is not an
  error.** A failed apply logs `provision failed` and exits 1 before
  listening. The startup event carries the created, updated and
  unchanged counts.

## Apply rules

- **Omitted fields stay as they are.** Only the fields a document
  names are written.
- **A supplied list replaces the held one.** A project's `members`
  adds and removes users to match.
- **Objects not named are never deleted.** Nor are knowledge docs a
  folder does not name.
- **A password and its change flag are creation-only.** Apply never
  resets an existing user's password.
- **Kinds apply in the order of `KINDS` in `parse.ts`.** A kind is
  applied after every kind it references. A reference names an object
  in the input or a live one.

## Rules per kind

- **`Mail` is the instance's one SMTP server.** A second `Mail`
  document is refused, and any name updates the server held. A new one
  needs `host`, `port`, `security`, `fromAddress` and
  `publicAddress`; `keyFrom` names an `email-` key file, null takes it
  off, and must be present.

- **An `Agent` is matched by name among live agents.** One naming a
  deleted agent creates a new agent. The automations the delete paused
  stay on the retired one, and there is no `Automation` kind to move
  them (`docs/automations.md`).
- **`default: true` is the only value for an `Agent` or `Decider`.**
  A second default of one kind in an apply is refused. Leaving it out
  keeps the mark where it is.
- **A `Decider`'s save checks the model against the live decisions
  catalog** (`docs/providers.md`). It fails while the provider's server
  is down.
- **A `Credential` is checked before anything is written.** Its key
  file must be present and usable. Its `projects` name team projects
  only. The per-project cap and prefix overlaps are checked over the
  held rows with the input laid on them.
- **A `Repository` is a team project's, matched by `project` and
  name.** The name is `spec.name`, else `metadata.name`, so two projects
  may each hold one named alike. `keyFrom` names an `http-` key file,
  null takes it off; `ignore` is a block string. Preflight checks one
  per project and name, the per-project cap, and that the key file is
  present and usable.
- **A `Project`'s `knowledge` is a folder relative to its YAML file.**
  It is never read from stdin, may not leave the file's directory, and
  refuses a symlink. Docs are named by their path and checked with the
  knowledge area's rules before apply. Apply creates a missing doc and
  replaces one whose text differs.
