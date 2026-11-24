# Deploy

How the binary runs outside the preview: as an OS service, on the
staging instance, in a container, and how releases are built. Governs
`src/server/service/`, `scripts/staging.sh`, `scripts/openshell.sh`,
the preview's mail catcher (`scripts/mail/`) and the `make staging-*`
targets, the `Dockerfile`, `.dockerignore`,
`deploy/` and `.github/workflows/`.

## The OS service (`1ctx service`)

`1ctx service install|start|stop|restart|status|uninstall` runs the
binary as a service of the signed-in user. Only macOS (launchd) is
supported today.

- **`service/` is CLI only.** It imports only `lib/` and opens no
  database. `service.ts` knows no platform; a new service manager is a
  `ServiceBackend` picked in `backendFor()`.
- **`install` parses its options with the server's `parseCli()`.** It
  refuses what the server would, pins relative paths and writes every
  option out. `start`, `restart` and `status` read them back from the
  definition. A start waits for `GET /api/health`.
- **`--drain` is a flag, never a limit.** It bounds how long a stop
  lets running chats and runs end (`docs/sessions.md`), 10 seconds by
  default, 0 for no wait. The preview runs with `--drain 0`.
- **The service manager's kill timeout is the drain plus 15.**
  launchd's `ExitTimeOut` is set so on install. A drain over 40 is
  refused, so the timeout stays under the 60 seconds `1ctx service
  stop` waits for the exit (`WAIT_MS` in `launchd.ts`). A Kubernetes
  `terminationGracePeriodSeconds` follows the same sum.
- **Health stays up while draining, ready goes down.** From the first
  signal `/api/health` answers 200 with `draining: true`, for a
  liveness probe. `/api/ready` answers 503, for a readiness probe.
  Neither is logged.
- **The log rotates only on install.** launchd holds it open while the
  service runs, so it moves to `.1` between the stop and the start.
- **`uninstall --purge` removes the database and the log, never the
  secrets.** The repositories' cache stays; it is only a cache.
- **`--cache <dir>` is the repositories' cache,** `repos/` beside the
  database by default (`~/.1ctx/repos` on staging). It can be lost, so
  it may be a volume of its own that is neither durable nor snapshotted
  (`docs/repos.md`); the deploy's `.backup` copies the database only.

## Staging

Staging is a 1ctx instance on a Mac, reached over ssh, used for real
work: its database holds real data that is never wiped. It runs the
binary through `1ctx service`, with its data under `~/.1ctx` on that
Mac. `scripts/staging.sh` drives it, behind `make staging-deploy`,
`staging-provision` and `staging-status`. The ssh host is in the
gitignored `scripts/staging.env` (copy `staging.env.example`) and is
never written in a tracked file.

- **`make staging-deploy` takes `main` only.** It refuses another
  branch or a dirty checkout unless `ALLOW_BRANCH=1`. A migration that
  ran on staging is never edited again, like one merged to `main`.
- **A deploy backs up the database before it swaps the binary.** It
  takes a `sqlite3 .backup` on the staging Mac, checks its integrity,
  keeps the last three, then uploads the new binary beside the live
  one and renames it over.
- **`make staging-provision` stops the service, applies and starts it
  again**, even when the apply fails. Only the `knowledge/` folder
  beside the YAML is copied, so a `knowledge` path elsewhere is
  refused.

## The sandbox gateway

The sandbox shell (`docs/sandbox.md`) needs OpenShell's gateway beside
the server. `scripts/openshell.sh` installs it from the pinned
release (0.1.9, its sha256 checked), makes its certificates once,
writes its config and runs it; never Homebrew, never `openshell
gateway add`.

- **macOS needs Apple silicon and Docker Desktop running.** OpenShell
  0.1.9 publishes no Intel macOS gateway. The script fails at once when
  `docker info` does not answer. Repositories need Docker Desktop on
  Docker VMM: on the Apple Virtualization framework its shares refuse
  every read of a repository's bind (`docs/sandbox.md`).
- **The config is fixed:** the Docker driver with bridge supervisor
  networking calling back on `https://host.openshell.internal:<port>`
  (under Docker Desktop `127.0.0.1` is the container's own), push
  policy delivery, bind mounts on and resource admission off for the
  repositories' binds, `sandbox_label = "1ctx-<instance id>"`, and
  telemetry off. It listens on `127.0.0.1:<port>`, its unauthenticated
  `/healthz` on the port plus 10000, metrics off. A start refuses
  either port held by another process, and health counts only once the
  listener is the gateway's own pid. Its log moves to `gateway.log.1`
  at each start.
- **Its client bundle is the `openshell-` keys.** The CA, client
  certificate and key are copied into the secrets folder as
  `openshell-gateway-{ca,cert,key}.key`; the endpoint is
  `https://127.0.0.1:<port>`.
- **The preview: `PREVIEW_SHELL=sandbox make preview`** runs one from
  `.preview/openshell/` on 17671 (`PREVIEW_GATEWAY_PORT` for a second
  checkout), after the server so its instance id is made, builds the
  saved variant's `dev-<variant>` image when missing, and turns the
  sandbox shell on with no custom image. A
  restart keeps an unchanged gateway. The server counts as up only when
  the preview port's one listener is the pid it started, so a stranger
  on the port is refused before the admin key is sent.
  `preview-stop` stops the gateway; `preview-clean` and `preview-reset`,
  with or without the variable, stop the server, delete every sandbox
  and provider under the instance label through the gateway (started for
  it when down), stop it and remove `.preview/openshell/`. A sandbox the
  gateway cannot delete stops the clean with the `docker rm -f` and
  `docker volume rm` commands for the containers and volumes labelled
  `openshell.ai/sandbox-namespace=1ctx-<instance id>`; once none is
  left, the clean goes on. A gateway that outlives its stop fails the
  command and keeps its pid file and directory. A new database under a
  kept gateway sweeps the old instance's sandboxes before the label
  changes.
- **Staging: `STAGING_SANDBOX=1` in `scripts/staging.env`** makes
  `make staging-deploy` install it under `~/.1ctx/openshell` as the
  LaunchAgent `dev.1ctx.openshell` (`STAGING_GATEWAY_PORT`, 17671),
  before the server's restart and checked healthy; on a box whose
  server has not made its instance id yet, right after, waiting up to
  30 s for the id. An unchanged gateway is never restarted, since a
  restart drops every lease; a changed config, binary or script is. The
  deploy copies the bundle into `~/.1ctx/secrets`; the shell is turned
  on in the admin page or a `Sandbox` document.
- **Docker Compose:** a gateway service beside the server, not built
  yet.
- **Kubernetes:** OpenShell's own Helm chart as a prerequisite, not
  built yet.

## The preview's mail catcher

- **The preview's email goes to a catcher on loopback,** the preview
  port + 2 (`PREVIEW_MAIL_PORT`), each message a mode 600 file in
  `.preview/mail/` (mode 700) named `<key>--<time>-<count>.eml`.
  `make preview-mail TO=<username or email>` prints the newest.
- **Its certificate is made at a start when missing or within two days
  of its end,** for 127.0.0.1 alone and not a CA, its key never leaving
  the folder; never the test fixture, which is a CA whose key is
  public. The server gets it through `NODE_EXTRA_CA_CERTS`, which Bun
  honours for nodemailer's TLS, so certificates stay verified and
  nothing else is added.
- **Its `SmtpServer` object is applied with `--provision` at each
  start,** after any provisioning, so a provisioned real server never
  wins. `PREVIEW_MAIL=real` starts no catcher and refuses to start while
  the SMTP server is still the endpoint the last setup saved in
  `.preview/mail/endpoint`, or when it cannot be read; provision the
  real one with it set.
- **A start refuses a preview port something already listens on.**
  One that fails before health and the optional sandbox step pass stops
  only the server and the catcher it launched, by pid, never by a scan
  of the port, so an older preview that lost its pid file is left alone.
- **Each recipient's copy is keyed by a hash of its address,** which
  heads the file as `X-Catcher-To`, so no address matches another's
  prefix. The catcher answers 250 only once every copy is written, 451
  otherwise.

## The container image

- **The build cross-compiles on `$BUILDPLATFORM`.** `bun build
  --compile --target` builds every platform natively, so nothing runs
  under emulation. The binary's `.env` and `bunfig.toml` autoload is
  off, since its working directory is the data volume.
- **`.dockerignore` is an allowlist.** The tree holds secrets.
- **The container runs as 65532 on a read-only root, with no Linux
  capabilities.** The server needs no writable `/tmp`; keep it so.
  `make image-smoke` runs the image that way and requires a clean exit
  on SIGTERM.
- **`CMD` holds the server flags; arguments replace it whole.** A
  Docker Compose `command:` or `docker run` arguments repeat every
  flag they keep.
- **Every file in `/secrets` must be readable by 65532.** It is
  mounted read-only. An unreadable key throws where it is read, and an
  unreadable `user-admin.key` fails the first start.
- **The first admin key is made before the first start.** The image's
  entry is the binary, so `docker run --rm <image> admin-key admin
  --stdout` prints one. For Docker Compose, write it to
  `secrets/user-admin.key` (readable by 65532); for the Helm chart,
  pipe it into the Secret the chart mounts at `/secrets`, under
  `user-admin.key`. With the binary at hand, `1ctx admin-key admin
  --secrets <dir>` writes the file itself, never over one, so a file
  that held a password is moved aside first.
- **The cache is `/data/repos` unless `--cache` names another
  mount,** which must be writable by 65532. The Helm chart mounts an
  `emptyDir` at `/cache` (`cache.sizeLimit`), off the claim.
- **`/data` is a named volume, never a bind mount on Docker Desktop
  or OrbStack.** Their VirtioFS breaks the POSIX locks SQLite's WAL
  needs, which hangs or corrupts the database. A named volume takes
  the image's `/data` with its owner 65532. On a Linux host a bind
  mount works once it is `chown 65532:65532`.
- **The sandbox image (`deploy/sandbox/Dockerfile`) pins its base, uv's
  Python 3.15 trixie-slim image that brings Python and uv, by digest,
  and every download by version and the sha256 its publisher gives,**
  checked at build: yq from its release. Bun, Go and Rust are copied
  from the official `oven/bun`, `golang` and `rust` slim images, pinned
  by digest, Rust's two homes moved under `/opt/home`; `oven/bun` is
  the root Dockerfile's, so the two move together. Dependabot bumps
  those digests and the base's; yq is bumped by hand. A new Bun,
  Go, Python or Rust minor bumps the bash description's versions in
  the same change (`docs/bash.md`), which a test checks. It makes every root the sandbox policy
  names and holds no helper: the server passes them with each exec.
- **Stop grace is the drain plus 15.** Docker's 10 second default
  would kill the shutdown after the drain. Docker Compose sets
  `stop_grace_period: 25s`; a plain run passes `--stop-timeout 25`.

## Docker Compose

- **`deploy/docker/compose.yaml` runs a release by `ONECTX_VERSION`,
  the tag.**
  `compose.dev.yaml`, layered over it with `ONECTX_VERSION=dev`, builds
  from the checkout and never pulls.

## Kubernetes

`deploy/charts/onectx/` is the Helm chart, `deploy/flux/` installs it with
Flux. Its README holds the values; these are the rules.

- **The templates fix what the server needs, never as values.** One
  replica with the `Recreate` strategy, since SQLite on a ReadWriteOnce
  volume has one writer. The image's user 65532, a read-only root, no
  capabilities, no service account token, no `/tmp` volume. Adding a
  value for any of these needs a reason the server gives.
- **The chart never makes the Secret.** It names one
  (`secrets.existingSecret`) and mounts it whole at `/secrets`, never by
  `subPath`, which would never see a rotated key.
- **The claim the chart renders is kept by default**
  (`helm.sh/resource-policy: keep`), so removing the release never
  removes the database. `fsGroupChangePolicy: OnRootMismatch` spares a
  large volume a chown on every start.
- **Probes follow the drain.** A startup probe on `/api/health` allows
  ten minutes for the migrations and `/provision`; liveness reads
  `/api/health`, readiness `/api/ready`. `terminationGracePeriodSeconds`
  is the drain plus 15.
- **`provision.files` rolls the pod through a checksum annotation.** An
  `existingConfigMap` applies on the next rollout; `--provision` is
  passed only when one of them is set.
- **An Ingress and a Gateway API `HTTPRoute` are both optional.** The
  Gateway is the cluster's; the chart only attaches a route.
- **`--trust-proxy` follows the chart's proxy.** `trustProxy` unset
  passes it only with `ingress.enabled` or `httpRoute.enabled`, since
  behind a bare Service any pod could forge `X-Forwarded-For` and dodge
  the per-address login limit; `true` or `false` is used as set.
- **The chart is named `onectx`,** since a Service name must start with
  a letter; the names helper fails a release name that starts with a
  digit rather than rename it.
- **`values.schema.json` refuses unknown keys.** A new value is typed
  there, in `values.yaml` and in the README's table in one change.

A local kind cluster, `1ctx-test` (context `kind-1ctx-test`), is where
the chart is tried by hand and where the load harness runs
(`docs/load-testing.md`). `make kind-up` creates it with metrics-server
(so `kubectl top` answers) and keeps the current kube context;
`make kind-image` builds the image and loads it as
`ghcr.io/stefanprodan/1ctx:dev`, which the chart runs with
`--set image.tag=dev` (pull policy `IfNotPresent`); `make kind-down`
deletes the cluster with every release in it.

## Release and CI

- **The Dockerfile's `oven/bun:<version>@sha256:<digest>` line is the
  one Bun version.** `scripts/bun-version.sh` hands it to `setup-bun`
  in every workflow, and Dependabot's `docker` ecosystem bumps it.
- **CI (`test.yml`) has three jobs.** `build-test` and `vendor-test`
  run on Linux for every pull request and push to `main`, side by
  side; they are the required checks. `build-test` runs `make lint`
  and fails on a tree it changed, the test files in parallel, the build
  and the binary's smoke test. `vendor-test` runs
  `make vendor-test ARGS=--parallel`. `macos-smoke` builds and
  smoke-tests the arm64 binary on macOS, on a push to `main` only, with
  no test suite.
- **`build-test` ends with its checks as parallel steps.** After Helm
  and the Flux CLI are set up, one `parallel:` group runs
  `make image-smoke` for amd64, `docker compose config` on both Compose
  files, `helm lint --strict` on the chart and `flux-schema` on the
  chart's default render and `deploy/flux/`, CEL rules included. Helm is
  set up at 4, which `flux-schema` needs. Nothing in CI runs the arm64
  image; it is smoke-tested by hand on an arm64 machine.
- **`e2e.yml` runs the load harness by hand** (`workflow_dispatch`) on a
  Linux runner: `cluster`, the default, builds the image into a fresh
  `1ctx-test` cluster and runs one step (inputs `mult`, `minutes`,
  `cpu`); `bench` builds a database (`preset`) and runs the source (`n`,
  `seconds`); `both` runs the two side by side. The results table goes
  to the run's summary and the logs to the `load-results-<target>`
  artifact. Never on a push or a pull request.
- **`models.yml` refreshes `models.json` weekly** and by hand: it runs
  `make models` and opens or updates one signed PR on `models-refresh`,
  labelled `chore`. A PR made with `github.token` starts no workflow,
  so the job dispatches `test.yml` (which takes `workflow_dispatch` for
  this) on the branch, and that run reports the required `build-test`
  and `vendor-test`. Never auto-merged.
- **A `v*` tag releases (`release.yml`) only a commit on `main`.**
  CI has already linted and tested it, so the release does not. The
  tag must be `vMAJOR.MINOR.PATCH[-PRERELEASE]`; a `-` makes a
  prerelease.
- **The release builds every archive on one Linux amd64 runner.** Bun
  cross-compiles linux arm64 and darwin arm64, the darwin build ad-hoc
  signed. Only the amd64 binary is smoke-tested there.
- **The release pushes `ghcr.io/stefanprodan/1ctx:<tag>`, never
  `latest`.** The image is amd64 and arm64, with provenance attested
  for it and for the archives' checksums.
- **The release pushes `ghcr.io/stefanprodan/1ctx-shell:<tag>-<variant>`
  for each variant first,** python, bun, go and rust, a matrix job
  building that target of `deploy/sandbox/Dockerfile` for the same
  platforms, each attested, plus the moving `:<variant>` for a run by
  hand, never on a prerelease. No bare `:<tag>`. The server runs only
  the versioned tag. `make sandbox-image` builds every variant locally
  as `1ctx-shell:dev-<variant>` and the registry name a source run's
  default names (`VARIANT=go` builds one). The first push creates the
  GHCR package `1ctx-shell` private; make it public once by hand.
- **The release pushes the Helm chart beside the image.** Its version is
  the tag without the `v` and its `appVersion` the tag, at
  `oci://ghcr.io/stefanprodan/charts/onectx`, with provenance attested.
