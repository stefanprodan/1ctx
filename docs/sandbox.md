# Sandbox

Governs `src/server/sandbox/`: the sandbox shell, its settings, the
gateway port, leases, the pool and the sweeps, and the wire contracts
in `shared/contracts/sandbox.ts` and `shared/api/sandbox.ts`.

The sandbox shell runs the bash tool's commands in an OpenShell
sandbox per workspace instead of just-bash in a worker. OpenShell's
gateway runs the sandboxes (Docker containers on macOS); 1ctx talks
only to the gateway, over gRPC with mutual TLS.

## Settings

- **One row, `sandbox_settings`, made by its migration.** Shell
  (`builtin` by default, or `sandbox`), the gateway endpoint, the
  image, and the instance id. The id is random, made at the row's
  first read and never changed; the migration leaves it null, so a
  database built from the migrations alone is the same file each time.
- **The instance id names everything 1ctx makes there.** Each sandbox
  and provider carries the label `onectx.dev/instance=<id>`; a Docker
  gateway serving the instance sets `sandbox_label = "1ctx-<id>"`
  (`gatewayLabel` in the GET answer), so another OpenShell on the same
  host never touches ours.
- **The endpoint is an https origin** (`https://host:port`), nothing
  else. The gateway's CA, client certificate and key are the secret
  files `openshell-gateway-ca.key`, `openshell-gateway-cert.key` and
  `openshell-gateway-key.key`, PEM. A route says only whether each is
  there.
- **Image null runs the default**, `ghcr.io/stefanprodan/1ctx-shell`
  tagged with the binary's version for a release, `dev` for a source
  run or a dev build, so an upgrade moves it along.
- **The shell is on when the row says `sandbox`, an endpoint is saved
  and every key file is there.** `compose.ts` passes bash a closure
  asked at each command: builtin until then. A save that changes the
  endpoint, a key or the image drains the old gateway's leases: every
  sandbox deleted.
- **Routes:** `GET` and `PUT /api/admin/sandbox` (a `PUT` to the
  sandbox shell without an endpoint or a key file is a 400), and
  `GET /api/admin/sandbox/leases`, every sandbox the instance holds.
  All admin.

## Limits

`sandboxesMax` (20), `sandboxWarm` (0, never above the cap),
`sandboxIdleMinutes` (5), `sandboxCpus` (2), `sandboxMemoryMiB`
(2048) and `sandboxHomeMiB` (512), scope `sandbox`. A sandbox takes
the CPU, memory and tmpfs sizes of when it was made.

## The gateway port

- **`gateway.ts` is the area's one view of OpenShell.** Only
  `openshell.ts` imports the SDK; the leases and a test's fake
  (`test/helpers/sandbox.ts`) see the port alone. Every call takes a
  signal, and the caller aborts it at its deadline.
- **Exec is single-attempt over the raw RPC** with a fresh request id
  and `noLoginShell`, never the SDK's curated stream, which retries
  before response headers.
- **A sandbox's name is `1ctx-` and 14 random characters:** the
  gateway refuses one over 19, so the instance is in the label alone.
- **A sandbox is made with its whole layout.** The image, the keep-alive
  (`/usr/bin/sleep infinity`), CPU and memory, the filesystem policy
  with Landlock `hard_requirement`, and Docker mounts: a tmpfs per
  writable root sized from its cap plus 8 MiB (`/tmp` scratch,
  `/knowledge` the project's docs, `/uploads`, `/mcp` kept files),
  `/opt/home` (HOME) and `/sandbox/tmp` from `sandboxHomeMiB`,
  `/sandbox/.1ctx` for 11 opened docs and 4 MiB; and a read-only bind
  per repository at `/repos/<name>`. OpenShell keeps the image's home
  and working folder (`/sandbox` in ours) for its
  workspace and fails a create that mounts there, so the image never
  names HOME as either. Docker mounts a tmpfs `noexec`, so `/tmp`, HOME
  and `/sandbox/tmp` pass the driver's `options: ["exec"]`.
- **Every exec runs with `SANDBOX_ENV`** (`spec.ts`): HOME, `TMPDIR`,
  `PATH` and uv's settings. An OpenShell exec sees none of the image's
  `ENV`.
- **The policy opens the devices shells and the fence use:**
  `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/tty`, `/dev/ptmx` and
  `/dev/pts` read-write, `/dev/urandom` and `/sys/fs/cgroup` read-only.
- **A policy is loaded when the sandbox reports its version active,**
  not when saved; a load error throws with its words.
- **A gateway-global policy refuses every command,** since it replaces
  each sandbox's own. It is checked at start and after a restart.

## Leases

- **One sandbox per workspace, never shared.** `acquire()` runs under
  the workspace's queue, before the process slot: the workspace's idle
  lease when its repository mounts equal the call's, else that one is
  recycled; a warm one for a call without repositories; else a create.
  Every step counts against the command's deadline; past it the
  answer is `busy`.
- **The keep-alive's pid is read once at create,** by bash builtins
  over `/proc`, and a sandbox without exactly one is never leased.
- **The cap counts creating, warm, leased, idle and deleting
  sandboxes,** and stuck ones the gateway does not report in `error`.
  At the cap a warm one goes first, then the least recently used idle
  one, never one in use; the command waits for the delete to be
  observed. No more deletes are pending for the cap than commands
  wait.
- **A recycle deletes; it never repairs.** A held lease is doomed and
  goes at its release. Clears, archives, deletes, a fork's source, a
  run's and a subagent's end recycle by the bus events
  (`events.ts`). An idle lease goes after `sandboxIdleMinutes`.
- **Deletes never block a command.** A delete waits for the gateway to
  forget the name, at most 60 s; past that the record is `stuck`, kept
  in memory, its phase asked every 5 minutes. A delete that fails
  before its timeout is asked again after 5 and 15 s, then is stuck.
  A stuck delete is asked again only by a sweep (a restart of the
  gateway or of 1ctx). A stuck sandbox in `error` has an exited
  container: remove its containers and volumes (labelled with its
  sandbox id) on the Docker host.
- **The cache trees a sandbox binds stay held until its delete is
  observed,** since an evicted tree's path can be published again and a
  bind does not follow it.
- **The warm pool refills in the background** to `sandboxWarm`, never
  past the cap or while a command waits for room, and again when an
  acquire ends; a failed create waits 30 s.
- **At start, every sandbox, then provider, under the instance label
  that no lease holds is deleted.** A sweep that cannot list marks the
  gateway lost, so the next probe that answers sweeps. A manager the
  settings moved off keeps its held sandboxes, which no other
  manager's sweep takes, deletes each as its command ends, and closes
  its client once none is left.
- **A gateway restart drops every lease** (`watch.ts`). A probe lists
  the labelled sandboxes every 30 s: a failure, then a success, is a
  restart, and so is every ready sandbox (two at least) listed in
  `error`, since a crashed gateway leaves them all there. Any other
  sandbox in `error` or not listed goes alone, a held one at its
  release. On a restart every lease is recycled and the labelled
  sandboxes swept again, stuck ones included. The backend calls
  `sandboxFailed(workspace)` when an exec says the sandbox is not ready
  or the gateway is unavailable: that lease goes and a probe starts.
  It returns at once and is never awaited on a command's path, since a
  probe may wait on a sweep's deletes.
- **A create cut by its signal may still land** after its delete found
  nothing. Its name is kept for 10 probes, and a probe that lists it,
  held by no lease, deletes it.
- **The client's HTTP/2 session is 1ctx's own,** closed with the
  gateway port.
- **A create or list the RPC cannot cancel** is waited for only until
  the step's signal; what the gateway still does is the next sweep's.

## Where the gateway runs

The preview runs its own with `PREVIEW_SHELL=sandbox`, staging as the
LaunchAgent `dev.1ctx.openshell` with `STAGING_SANDBOX=1`, both from
`scripts/openshell.sh`; `docs/deploy.md` has the rules. The admin page
Sandbox (`/admin/config/sandbox`, `docs/admin-pages.md`) edits the
row, shows which key files are there, never their values, and lists
the leases with stuck ones named.
