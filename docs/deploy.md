# Deploy

How the binary runs outside the preview: as an OS service, on the
staging instance, in a container, and how releases are built. Governs
`src/server/service/`, `scripts/staging.sh` and the `make staging-*`
targets, the `Dockerfile`, `.dockerignore`, `deploy/` and
`.github/workflows/`.

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
- **The cache is `/data/repos` unless `--cache` names another
  mount,** which must be writable by 65532. The Helm chart mounts an
  `emptyDir` at `/cache` (`cache.sizeLimit`), off the claim.
- **`/data` is a named volume, never a bind mount on Docker Desktop
  or OrbStack.** Their VirtioFS breaks the POSIX locks SQLite's WAL
  needs, which hangs or corrupts the database. A named volume takes
  the image's `/data` with its owner 65532. On a Linux host a bind
  mount works once it is `chown 65532:65532`.
- **Stop grace is the drain plus 15.** Docker's 10 second default
  would kill the shutdown after the drain. Docker Compose sets
  `stop_grace_period: 25s`; a plain run passes `--stop-timeout 25`.

## Docker Compose

- **`deploy/docker/compose.yaml` runs a release by `ONECTX_VERSION`,
  the tag.**
  `compose.dev.yaml`, layered over it with `ONECTX_VERSION=dev`, builds
  from the checkout and never pulls.

## Kubernetes

`deploy/charts/1ctx/` is the Helm chart, `deploy/flux/` installs it with
Flux. Its README holds the values; these are the rules.

- **The templates fix what the server needs, never as values.** One
  replica with the `Recreate` strategy, since SQLite on a ReadWriteOnce
  volume has one writer. The image's user 65532, a read-only root, no
  capabilities, no service account token, no `/tmp` volume. Adding a
  value for any of these needs a reason the server gives.
- **The chart never makes the Secret.** It names one
  (`secrets.existingSecret`) and mounts it whole at `/secrets`, never by
  `subPath`, which would never see a rotated key. No doc tells the
  reader to run `kubectl`: every step is a value, a file in Git or a
  Flux object.
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
- **A Service name must start with a letter.** The names helper spells
  a leading `1ctx` as `onectx`.
- **`values.schema.json` refuses unknown keys.** A new value is typed
  there, in `values.yaml` and in the README's table in one change.

## Release and CI

- **The Dockerfile's `oven/bun:<version>@sha256:<digest>` line is the
  one Bun version.** `scripts/bun-version.sh` hands it to `setup-bun`
  in every workflow, and Dependabot's `docker` ecosystem bumps it.
- **CI (`test.yml`) has a macOS and a Linux job.** Only the macOS job
  runs `make lint` and `make vendor-test`. Only the Linux job runs the
  test files in parallel and `make image-smoke` for amd64. Nothing in CI
  runs the arm64 image; it is smoke-tested by hand on an arm64 machine.
- **The Linux job checks `deploy/`.** It runs `docker compose config` on
  both Compose files, `helm lint --strict` on the chart, and `flux-schema`
  on the chart's default render and `deploy/flux/`, CEL rules included.
  Helm is set up at 4, which `flux-schema` needs.
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
- **The release pushes the Helm chart beside the image.** Its version is
  the tag without the `v` and its `appVersion` the tag, at
  `oci://ghcr.io/stefanprodan/charts/1ctx`, with provenance attested.
