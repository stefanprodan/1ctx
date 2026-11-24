# Sandbox image

How the sandbox shell's image is built. Governs `deploy/sandbox/`
(the variants Dockerfile, `base/` and `checks/`),
`scripts/sandbox-image.sh`, `scripts/sandbox-image-check.ts`,
`scripts/sandbox-tools.ts` and `.github/workflows/shell-base.yml`.
What a release pushes is in `docs/deploy.md`; how the server runs the
image, its environment and its roots in `docs/sandbox.md`.

## The variants

- **`deploy/sandbox/Dockerfile` is one target per variant.** `base`
  is uv's Python 3.15 on Debian trixie with bash, git, make, curl, jq,
  yq, ripgrep and pdftotext, the sandbox user and every root. `python`
  is `base`; `bun` adds Bun, with `node` linked to `bun` (`node
  --version` is not answered) and `npx` a wrapper running `bun x`;
  `cc` (never pushed as a variant) adds `gcc` and `libc6-dev`, shared
  by `go` (Go in `/usr/local/go`) and `rust` (the official image's
  pinned stable toolchain, minimal profile, moved to
  `/opt/home/.rustup` and `/opt/home/.cargo`, owned by the sandbox
  user, since `/usr` is read-only under Landlock and HOME is the
  container's own disk). Its `base` and `cc` are still its own copy
  of the base image's stages, with Debian's git and ripgrep. Measured
  locally (`docker images`, linux/arm64, 2026-11-20): python 439 MB,
  bun 602 MB, go 1.06 GB, rust 1.44 GB; python 488 MB with pdftotext.
- **The variants Dockerfile pins every image it takes from by digest
  and downloads nothing of its own:** uv's Python 3.15 trixie-slim
  image that brings Python and uv, and the official `jqlang/jq`,
  `mikefarah/yq`, `oven/bun`, `golang` and `rust` slim images that jq,
  yq, Bun, Go and Rust are copied from, Rust's two homes moved under
  `/opt/home`. `oven/bun` is the root Dockerfile's, so the two move
  together. Dependabot bumps every digest. The apt packages are
  trixie's on the day of the build. A new Bun, Go, Python or Rust
  minor bumps the bash description's versions in the same change
  (`docs/bash.md`), which a test checks. The image makes every root
  the sandbox policy names and holds no helper: the server passes them
  with each exec.
- **`make sandbox-image` builds every variant locally** as
  `1ctx-shell:dev-<variant>` and the registry name a source run's
  default names (`VARIANT=go` builds one).

## The base image

- **`deploy/sandbox/base/Dockerfile` holds every step that runs a
  command:** `base` (what the python variant holds) and `cc` (`base`
  with `gcc` and `libc6-dev`). uv's image is named once, as the
  `trixie` stage, and both `base` and git's build start from it, so
  git links the libraries the base ships. `cc` builds its own copy of
  `base`, so the two share no apt layer. Nothing runs this image: the
  server runs `1ctx-shell`. Measured locally (linux/arm64,
  2026-11-25): base 415 MB and cc 709 MB, from 489 MB and 783 MB with
  Debian's git and ripgrep.
- **`shell-base.yml` publishes `ghcr.io/stefanprodan/1ctx-shell-base`:**
  `trixie` and `trixie-cc`, each with a dated `-YYYYMMDD` tag that is
  never moved and is deleted by hand. It runs Mondays, by hand, on a
  push to `main` changing `deploy/sandbox/base/` or the workflow, and
  on a pull request changing them. `docker/github-builder` builds each
  platform on its own native runner with no QEMU, joins them into one
  index and signs its provenance with cosign; `attest` adds GitHub's
  attestation to each digest, and `smoke` pulls them on both runners
  and runs the offline contract (below), python's on `trixie` and
  cc's on `trixie-cc`. The builder has no step before its push, so a
  failed smoke leaves a moved tag and a red run.
- **Only `main` publishes.** The push, `attest` and `smoke` run only
  on `refs/heads/main` (and the one other branch listed under
  `on.push.branches`, named in each of those rules, until the first
  base is published). Any other ref, a pull request or a dispatch
  included, builds both targets and stops, so a bump's branch is built
  before it merges. Only publishing runs share the `publish`
  concurrency group.

## git and ripgrep

- **git and ripgrep are built from source at pinned versions.**
  Debian trixie's lag years behind and neither project publishes an
  image to copy from; on the native runners the build takes minutes.
  Four `ARG` lines at the top of the base Dockerfile are the pins,
  each alone on its line: `GIT_VERSION`, `GIT_SHA256`, `RG_VERSION`,
  `RG_SHA256`. Each source is taken with `ADD --checksum`: git's
  tarball from kernel.org, ripgrep's crate (a tar.gz with its
  `Cargo.lock`) from crates.io. The build stages never ship; `base`
  copies their output into `/usr/local`, ahead of `/usr/bin` on PATH.
- **git keeps what a chat uses:** https through Debian's libcurl with
  OpenSSL, so the CA bundle (`/etc/ssl/certs/ca-certificates.crt`) and
  the proxy variables are libcurl's, as for curl; `git grep -P`
  through PCRE2; zlib; the system config at `/etc/gitconfig`, as
  Debian's git reads it. It leaves out Perl, Python, Tcl/Tk, gettext,
  expat (push over dumb http), the optional Rust code and the docs.
  Dashed built-ins are skipped and the rest are symlinks, never
  hardlinks, and the binaries are stripped: about 20 MB in all. `base`
  installs the libraries git links by name (`libcurl4t64`,
  `libpcre2-8-0`, `libssl3t64`, `zlib1g`), never through curl's
  dependencies.
- **ripgrep builds on the variants Dockerfile's `rust` image,** the
  same tag and digest, so Dependabot moves both. `cargo build
  --release --locked --features pcre2` checks every dependency against
  the crate's lock file, and `PCRE2_SYS_STATIC=1` links PCRE2 in, so
  `rg` needs only libc and libgcc_s.
- **`make sandbox-tools` moves the pins** to the newest stable
  releases: git's highest `vX.Y.Z` tag on GitHub, sorted by version,
  never a release candidate; ripgrep's newest stable crate on
  crates.io. git's sha256 is computed from the downloaded tarball and
  must equal its entry in kernel.org's `sha256sums.asc`, else nothing
  changes; ripgrep's is the one crates.io lists. It rewrites only the
  four lines, never moves a pin back, and changes nothing when the
  pins are current. `--diff` prints what moved against `HEAD`, as
  Markdown, empty when nothing did. The version choice, the list's
  parse and the rewrite are pure and tested on fixtures.
- **The `tools` job bumps them through one pull request,** on the
  schedule and by hand, on `main` only: it runs `make sandbox-tools`
  and opens or updates a signed pull request on `shell-tools`,
  labelled `build`, holding only the base Dockerfile, as `models.yml`
  does for the catalog. A pull request made with `github.token` starts
  no workflow, so the job dispatches `test.yml` and `shell-base.yml`
  on the branch; the latter only builds there. Never auto-merged; its
  merge publishes a base with the new tools.

## The contract

- **Each variant's promise is a contract, `deploy/sandbox/checks/`**:
  `common.sh` (the harness and what every variant holds) and one file
  per variant, plus `cc.sh` for the base image's gcc target, shell
  checks that must exit 0. `make sandbox-image-check
  [ARGS="--variant go --image <ref> --offline"]` sends them through
  the sandbox backend to a real gateway, the preview's by default: the
  offline checks with the network off, then at most one online check
  per variant on the default hosts. `--docker` runs the offline half
  on `docker run --network none` as the image's own user, which is
  what CI runs. Run it on every image change.
- **A check names no version or path of its own.** Versions come from
  `SHELL_VERSIONS` as `EXPECT_<TOOL>`, paths from the env the server
  sends. git and ripgrep are checked by what a chat uses (a commit
  read back, `git grep -P`, the https helper reaching libcurl, `rg
  --pcre2`), never by version, so a base bump never fails a variant
  still built on an older base.
