# Sandbox

Governs `src/server/sandbox/`: the sandbox shell, its settings, the
gateway port, leases, the pool and the sweeps, and the wire contracts
in `shared/contracts/sandbox.ts` and `shared/api/sandbox.ts`. Its
network and credentials are in `docs/sandbox-network.md`, a command and
the sandbox a chat shares with its subagents in
`docs/sandbox-commands.md`.

The sandbox shell runs the bash tool's commands in an OpenShell
sandbox per chat instead of just-bash in a worker; a chat's subagents
run theirs in the same one. OpenShell's
gateway runs the sandboxes (Docker containers on macOS); 1ctx talks
only to the gateway, over gRPC with mutual TLS.

## Settings

- **One row, `sandbox_settings`, made by its migration.** The backend
  (`builtin` by default, or `openshell`), the gateway endpoint, the
  image variant (`python` by default, `bun`, `go` or `rust`), the
  custom image, the network (`hosts` by default, or `off`), the hosts (JSON,
  null for the defaults), and the instance id. The id is random, made at the row's
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
- **Image null runs the variant's default**,
  `ghcr.io/stefanprodan/1ctx-shell:<version>-<variant>` for a release,
  `dev-<variant>` for a source run or a dev build (`defaultImage()`),
  so an upgrade moves it along. The server never runs a moving tag:
  `SANDBOX_ENV` and the image's layout ship together. A custom image
  runs as saved and the variant is kept but ignored (`imageOf()`).
  `defaultImages` in the GET answer names each variant's. An instance
  on the default image before the variants, which held Bun, runs
  `python` until an admin picks `bun`.
- **Bash's description names the variant's tools.** `variant()`
  answers a project's effective variant, null for a custom image, and
  `offeredShell()` reads it at the turn's start, as it reads the
  network; a variant saved mid-turn drains the manager, so the turn's
  later commands run the new variant under the old words, as with an
  image or network change. `tools/builtin/shell-tools.ts` holds one row per
  variant (its tools line and install hint, at the Dockerfile's
  versions) and the custom image's: Python 3 with uv, and `command -v`
  for the rest. A test reads the Dockerfile's `FROM` tag and version
  args and fails when a row disagrees.
- **A project may pick its own backend and variant**
  (`projects.backend`, `builtin` or `openshell`; `projects.variant`, the
  four words); null follows the instance's. A custom image on the
  instance beats a project's variant too. The sandbox area reads both
  through a port from `compose.ts`, since projects sit above it.
- **A project's shell is on when its backend is `openshell`, an
  endpoint is saved and every key file is there.** `compose.ts` passes
  bash a closure asked at each command with the project: builtin until
  then. The tool offer's `sandbox()` asks the same with the send's
  project, so a turn's offer and its commands agree. `active` in the
  GET answer is the instance's alone; `overrides` counts the projects
  that pick each backend.
- **One gateway manager serves every project,** keyed by the endpoint,
  the keys and the instance's image. It is made when a command needs
  it, at a save while the instance or a project runs `openshell`, and
  at start whenever a gateway is saved, so its sweep takes what an
  earlier run left. A save that changes the endpoint, a key, the variant or the
  custom image drains the
  old gateway's leases: every sandbox deleted, and so does a key file
  gone, at the next command, and any save while nothing runs
  `openshell`, once a sweep of the manager listed every kind; a new
  gateway then gets a manager whose start sweep takes what was left. A
  project's change drains nothing:
  its next command takes the other shell, `$HOME` and `/tmp` of the old
  one stay behind, and an unused sandbox goes by the idle sweep. While
  nothing runs `openshell` the warm pool empties and makes none, and the
  manager goes once it holds no sandbox and a sweep of it has listed
  every kind. A project's backend change or delete asks it at once
  (`projectsChanged()`); whether any project runs `openshell` is one
  indexed lookup, since it is asked often.
- **A lease carries the image it was made from** (`Lease.image`), its
  project's (`imageOf`, read at each pass of the lease loop). A command
  whose project now names another image lets its chat's sandbox go
  once its commands end, as other repositories do, and gets one of the
  new image; other projects' sandboxes stay, and nothing drains. The
  warm pool makes the instance's image alone; another is made cold.
- **The hosts are the sandbox's own, never Web access's list.**
  `shared/sandbox-net.ts` parses them for the page and the route: at
  most 200, each a host name (an IDN in its ASCII form) or an OpenShell
  wildcard, three labels at least, `*` within the first label or as a
  whole later one, `**` only as the whole first label. No port,
  scheme, path or IPv6 literal. `SANDBOX_DEFAULT_HOSTS` holds the
  defaults: package and container registries, code hosts, CDNs, reference docs and news.
  A list equal to them, in any order, is stored as null, so a later
  release's defaults reach the instance. The hosts network needs one
  host.
- **Routes:** `GET` and `PUT /api/admin/sandbox` (a `PUT` to the
  sandbox shell without an endpoint or a key file is a 400), and
  `GET /api/admin/sandbox/leases`, every sandbox the instance holds
  and `refused`, why every command is refused (the image's root check,
  a gateway-global policy), else null. All admin.

## Limits

`sandboxesMax` (20), `sandboxWarm` (0, never above the cap),
`sandboxIdleMinutes` (30), `sandboxCpus` (4), `sandboxMemoryMiB`
(4096) and `sandboxCommandSeconds` (600, a command's time in place of
the call timeout, `docs/bash.md`), scope `sandbox`. `toolMs` (20
minutes) holds a full command and ends under a chat's deadline; an automation run is still bounded by
`runDeadlineMs` (10 minutes by default), and a chat turn by
`sendDeadlineMs`. A sandbox takes the CPU, memory and tmpfs
sizes of when it was made. No limit of ours bounds its disk (below).

## The gateway port

- **`gateway.ts` is the area's one view of OpenShell.** Only
  `openshell.ts` and `providers.ts` import the SDK; the leases and a
  test's fake (`test/helpers/sandbox.ts`) see the port alone. Every
  call takes a signal, and the caller aborts it at its deadline.
- **Exec is single-attempt over the raw RPC** with `noLoginShell` and
  no request id, never the SDK's curated stream, which retries before
  response headers. A request id is a durable admission the gateway
  keeps for its replay window (a cut one forever), at most 1,000 per
  caller, so a busy instance would lock itself out of every create;
  never retrying is what keeps a launch at most once.
- **A sandbox's name is `1ctx-` and 14 random characters:** the
  gateway refuses one over 19, so the instance is in the label alone.
  A create the gateway answers with the name held (`NameTaken`) deletes
  nothing, since that sandbox is another's; any other failed create is
  deleted, since it may have landed.
- **A sandbox is made with its whole layout.** The image, the keep-alive
  (`/usr/bin/sleep infinity`), CPU and memory, the filesystem policy
  with Landlock `hard_requirement`, and Docker mounts: a tmpfs per
  synced root sized from the larger of its cap and what the call's
  rows hold (`ShellCall.stored()`, the totals alone), plus 8 MiB, so a
  tree over a lowered cap still mounts to be shrunk (`/knowledge` the
  project's docs, `/uploads`, `/mcp` kept files), `/sandbox/.1ctx` for
  11 opened docs and 4 MiB; and a read-only bind per repository at
  `/repos/<name>`. `/tmp`, `/opt/home` (HOME) and `/sandbox/tmp` are
  the container's own disk, made by the image: a tmpfs counts against
  the memory limit. OpenShell keeps the image's home and working folder
  (`/sandbox` in ours) for its workspace and fails a create that
  mounts there, so the image never names HOME as either. A warm
  sandbox is sized from the caps alone, so a call over one never takes
  it.
- **`/tmp` is the sandbox's own, never the chat's scratch rows.** The
  backend says `ownTmp`, so `mount.ts` reads no scratch file, drops
  none whose name the rule no longer allows, and commits no file
  change: only the cwd, never `used_at`, so hidden rows age out, and
  without the scratch caps. `/tmp`
  is never pushed, walked or pulled (`SANDBOX_ROOTS`), the read back
  sees it as an empty scratch the command left alone, and a cwd under
  it is checked by an exec. Its files go when the sandbox is recycled.
- **The image's first sandbox is checked for every root** (`roots.ts`),
  since Landlock skips a missing path: each writable root a folder that
  takes a file, `/repos` a folder. A manager checks each image until
  one sandbox passes (`ImageChecks`); a failure refuses that image's
  commands for good, naming it, so a project variant's image refuses
  that project's alone. Only the instance's stops the pool and shows as
  the leases route's `refused`.
- **A sandbox made with repositories lists each once** (`binds.ts`),
  after the root check, since some Docker hosts bind one so every read
  under it is refused (Docker Desktop on the Apple Virtualization
  framework) while the image passes. One that cannot be listed fails
  that create with words naming it and Docker VMM, and logs a warning
  with the sandbox and how many, never the names; the sandbox goes,
  the image is never refused, and a sandbox without repositories is
  never asked.
- **Every exec runs with `SANDBOX_ENV`** (`spec.ts`): HOME, `TMPDIR`,
  `PATH` (with `/usr/local/go/bin`, `$HOME/go/bin` and
  `$HOME/.cargo/bin`), uv's settings, bun's (its cache and global
  packages under HOME, never `/knowledge`), Go's (`GOPATH`, `GOCACHE`
  and `GOMODCACHE` under `$HOME/go`, `CGO_ENABLED=1`, `CC=gcc`),
  `CARGO_HOME` and `RUSTUP_HOME` under HOME, and `DO_NOT_TRACK`. One
  set for every variant, never branched on it. An OpenShell exec sees
  none of the image's `ENV`.
- **The image (`deploy/sandbox/Dockerfile`) is one target per
  variant.** `base` is uv's Python 3.15 on Debian trixie with bash,
  git, make, curl, jq, yq, ripgrep and pdftotext, the sandbox user and every root;
  the helpers run `/usr/local/bin/python3 -I -S` and `/usr/bin/bash`,
  so every variant keeps it. `python` is `base`; `bun` adds Bun, with
  `node` linked to `bun` (`node --version` is not answered) and `npx`
  a wrapper running `bun x`; `cc` (never pushed) adds `gcc` and `libc6-dev`, shared by
  `go` (Go in `/usr/local/go`) and `rust` (the official image's pinned
  stable toolchain, minimal profile, moved to `/opt/home/.rustup` and
  `/opt/home/.cargo`, owned by the sandbox user, since `/usr` is
  read-only under Landlock and HOME is the container's own disk).
  `rustup` adds a toolchain or target beside it from
  `static.rust-lang.org`, and `uv run --python 3.X` another Python
  from `releases.astral.sh`, both default hosts, into HOME until the
  sandbox is recycled. Nothing of ours walks, pushes or pulls HOME; the
  root check only writes and removes its probe file there. Measured
  locally (`docker images`, linux/arm64, 2026-11-20): python 439 MB,
  bun 602 MB, go 1.06 GB, rust 1.44 GB; python 488 MB with pdftotext.
- **The policy opens the devices shells and the fence use:**
  `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/tty`, `/dev/ptmx` and
  `/dev/pts` read-write, `/dev/urandom` and `/sys/fs/cgroup` read-only.
- **A policy is loaded when the sandbox reports its version active,**
  not when saved; a load error throws with its words.
- **A gateway-global policy refuses every command,** since it replaces
  each sandbox's own. It is checked at start, after a restart and
  before each command's network (below); the lease stays. Once either
  saw one, the pool stops, the leases route's `refused` names it, and a
  refused command asks again at most every 10 s, so removing it
  unblocks commands.

## Leases

- **One sandbox per root workspace.** A call's `root` is its own
  workspace, or a subagent's parent's (the backend says
  `sharedWithSubagents`). `acquire()` runs under the workspace's queue,
  before the process slot: the root's lease, idle or held, when its
  repository mounts equal the call's and nothing doomed it, else an
  idle one is recycled. A lease takes at most `SANDBOX_COMMANDS` (6,
  `holders.ts`) holders, since each command keeps its mount in memory
  to its end; one past it waits for a release; a warm one for a call without repositories;
  else a create. A held lease that differs or is doomed is waited for.
  Every step counts against the command's deadline; past it the answer
  is `busy`.
- **A lease counts its holders.** It goes idle at the last release,
  and the idle clock starts there. The network is set up in the
  sandbox's turn (below), since its holders run at once; a recycle or
  a retire (a failed setup, a plan that differs) while a command waits
  for that turn sends it on to a fresh sandbox.
- **The keep-alive's pid is read once at create,** by bash builtins
  over `/proc`, and a sandbox without exactly one is never leased.
- **The cap counts creating, warm, leased, idle and deleting
  sandboxes,** and stuck ones the gateway does not report in `error`,
  a retired manager's (below) included.
  At the cap a warm one goes first, then the least recently used idle
  one, never one in use; the command waits for the delete to be
  observed, and no more are pending than commands wait at the cap.
- **A recycle deletes; it never repairs.** A held lease is doomed and
  goes at its last release; one doomed while it was made is deleted,
  never handed out. A holder's own recycle (a failed step or put-back,
  a hostile record) also aborts `lost`, so the others stop at once and
  save nothing. Beside other holders, a command's own stop or deadline
  and a failed network setup retire the lease instead (`retire()`):
  doomed, never joined, deleted at the last release, `lost` left alone.
  Clears, archives, deletes and a run's end recycle by the bus
  events (`events.ts`); a subagent's end does not, and a fork leaves its
  source's sandbox alone. An idle lease goes after `sandboxIdleMinutes`.
- **Deletes never block a command.** A delete waits for the gateway to
  forget the name, at most 60 s; past that the record is `stuck`, kept
  in memory, its phase asked every 5 minutes. A delete that fails
  before its timeout is asked again after 5 and 15 s, then is stuck.
  A stuck delete is asked again only by a sweep (a restart of the
  gateway or of 1ctx, or the hourly one). A stuck sandbox in `error` has an exited
  container: remove its containers and volumes (labelled with its
  sandbox id) on the Docker host.
- **The cache trees a sandbox binds stay held until its delete is
  observed,** since an evicted tree's path can be published again and a
  bind does not follow it.
- **The warm pool refills in the background** to `sandboxWarm`, never
  past the cap or while a command waits for room, and again when an
  acquire ends; a failed create waits 30 s (`pool.ts`). A save of the
  limits wakes the commands waiting at the cap and deletes the warm
  sandboxes past a lowered `sandboxWarm`, and one still being made when
  it lands.
- **At start, every sandbox, then provider, under the instance label
  that no lease holds is deleted.** A command waits, at most to its
  deadline, until a sweep has listed and recorded them, so they count
  against the cap. A start sweep that cannot list the sandboxes keeps
  commands waiting and the pool empty until a later sweep lists. A
  sweep that cannot list the
  sandboxes, providers or profiles marks itself to run again, and the
  next probe that answers sweeps, dropping no lease: a blip of one list
  is never read as a restart. A manager the
  settings moved off (retired) leases nothing, refuses its waiting
  commands at once, keeps its held sandboxes, which no other manager's
  sweep takes, and deletes each as its command ends, retries included.
  A stuck one it keeps, trees and phase checks included, until the
  gateway forgets it or three phase checks (`RETIRED_STUCK_CHECKS`)
  passed, since the replacement's start sweep skipped it while it was
  deleting; a later sweep asks its delete again, and the name it then
  holds counts once against the cap. A stuck sandbox it gave up on is
  looked at again only by a start sweep, a restart, an "again" or the
  hourly sweep. It closes its client once no
  record is left and its providers' deletes ended; after a close a
  failed provider delete is not asked again.
- **A gateway restart drops every lease** (`watch.ts`). A probe lists
  the labelled sandboxes every 30 s: a failed probe marks the gateway
  lost, and the next that answers is a restart, and so is every ready
  sandbox (two at least) listed in `error`, since a crashed gateway
  leaves them all there. Any other
  sandbox in `error` or not listed goes alone, a held one at its
  release. On a restart every lease is recycled and the labelled
  sandboxes swept again, stuck ones included. A probe that answers
  sweeps as well once `SWEEP_MS` (an hour) passed since the last sweep,
  dropping no lease, so what a lost answer left goes in time. The backend calls
  `sandboxFailed(workspace)` when an exec says the sandbox is not ready
  or the gateway is unavailable: that lease goes and a probe starts.
  It returns at once and is never awaited on a command's path, since a
  probe may wait on a sweep's deletes.
- **A create cut by its signal may still land** after its delete found
  nothing. Its name is kept for 10 probes, and a probe that lists it,
  held by no lease, deletes it.
- **The client's HTTP/2 session is 1ctx's own,** closed with the
  gateway port.
- **Create, list and a policy's save go through the raw RPCs** with
  the step's signal, as every other call, so a wait that ends cancels
  its RPC: a gateway that never answers holds no more than one call per
  wait. A create cut that still lands is the probe's or the next
  sweep's.

## Where the gateway runs

The preview runs its own with `PREVIEW_SHELL=sandbox`, staging as the
LaunchAgent `dev.1ctx.openshell` with `STAGING_SANDBOX=1`, both from
`scripts/openshell.sh`; `docs/deploy.md` has the rules. The admin page
Sandbox (`/admin/config/sandbox`, `docs/admin-pages.md`) edits the
row, shows which key files are there, never their values, and lists
the leases with stuck ones named.
