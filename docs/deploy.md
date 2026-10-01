# Deploy

Governs `src/server/service/`, `scripts/staging.sh` and the staging
targets, the `Dockerfile`, `.dockerignore`, `deploy/` and
`.github/workflows/`.

## The OS service (`1ctx service`)

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
- **The manager's kill timeout is the drain plus 15.** launchd's
  `ExitTimeOut` is set so on install, and a drain over 40 is refused,
  keeping it under the stop's own 60 second wait. A Kubernetes
  `terminationGracePeriodSeconds` follows the same sum.
- **Health stays up while draining, ready goes down.** From the first
  signal `/api/health` answers 200 with `draining: true`, for a
  liveness probe. `/api/ready` answers 503, for a readiness probe.
  Neither is logged.
- **The log rotates only on install.** launchd holds it open while the
  service runs, so it moves to `.1` between the stop and the start.
- **`uninstall --purge` removes the database and the log, never the
  secrets.**

## Staging

- **Staging takes `main` only.** `staging-deploy` refuses another
  branch or a dirty checkout unless `ALLOW_BRANCH=1`. A migration that
  ran on staging is frozen as if merged.
- **A deploy backs up before it swaps.** It takes a `sqlite3 .backup`
  on the box, checks its integrity, keeps the last three, then uploads
  the binary beside the live one and renames it.
- **`staging-provision` stops the service, applies and starts it
  again**, even when the apply fails. Only the `knowledge/` folder
  beside the YAML is copied, so a `knowledge` path elsewhere is
  refused.

## The container image

- **The build cross-compiles on `$BUILDPLATFORM`.** `bun build
  --compile --target` builds every platform natively, so nothing runs
  under emulation. The binary's `.env` and `bunfig.toml` autoload is
  off, since its working directory is the data volume.
- **`.dockerignore` is an allowlist.** The tree holds secrets.
- **The container runs as 65532 on a read-only root, with no
  capabilities.** The server needs no writable `/tmp`; keep it so.
  `make image-smoke` runs the image that way and requires a clean exit
  on SIGTERM.
- **`CMD` holds the server flags; arguments replace it whole.** A
  Docker Compose `command:` or `docker run` arguments repeat every
  flag they keep.
- **Every file in `/secrets` must be readable by 65532.** It is
  mounted read-only. An unreadable key throws where it is read, and an
  unreadable `user-admin.key` fails the first start.
- **`/data` is a named volume, never a bind mount on Docker Desktop
  or OrbStack.** Their VirtioFS breaks the POSIX locks SQLite's WAL
  needs, which hangs or corrupts the database. A named volume takes
  the image's `/data` with its owner 65532. On a Linux host a bind
  mount works once it is `chown 65532:65532`.
- **Stop grace is the drain plus 15.** Docker's 10 second default
  would kill the shutdown after the drain. Docker Compose sets
  `stop_grace_period: 25s`; a plain run passes `--stop-timeout 25`.

## Docker Compose

- **`compose.yaml` runs a release by `ONECTX_VERSION`, the tag.**
  `compose.dev.yaml`, layered over it with `ONECTX_VERSION=dev`, builds
  from the checkout and never pulls.

## Release and CI

- **The Dockerfile's `oven/bun:<version>@sha256:<digest>` line is the
  one Bun version.** `scripts/bun-version.sh` hands it to `setup-bun`
  in every workflow, and Dependabot's `docker` ecosystem bumps it.
- **Only the macOS job lints and runs `make vendor-test`.** The Linux
  job alone tests with `--parallel` and smokes the amd64 image. The
  arm64 image is smoked on an arm64 dev machine.
- **A `v*` tag releases only a commit on `main`.** CI has already
  linted and tested it, so the release does not. The tag must be
  `vMAJOR.MINOR.PATCH[-PRERELEASE]`; a `-` makes a prerelease.
- **The release builds every archive on one Linux amd64 runner.** Bun
  cross-compiles linux arm64 and darwin arm64, the darwin build ad-hoc
  signed. Only amd64 is smoked there.
- **The release pushes `ghcr.io/stefanprodan/1ctx:<tag>`, never
  `latest`.** The image is amd64 and arm64, with provenance attested
  for it and for the archives' checksums.
