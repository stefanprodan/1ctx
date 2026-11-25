# Sandbox image

How the sandbox shell's image is built. Governs `deploy/sandbox/`
(the variants Dockerfile, `base/`, `checks/` and the README),
`scripts/sandbox-image.sh`, `scripts/sandbox-image-check.ts`,
`scripts/sandbox-tools.ts` and `.github/workflows/shell-base.yml`.
What a release pushes is in `docs/deploy.md`; how the server runs the
image, its environment and its roots in `docs/sandbox.md`.
`deploy/sandbox/README.md` is the reference for people: the images,
their tags, every tool with its version and source, what a custom image
needs; this doc keeps the rules.

## The variants

- **`deploy/sandbox/Dockerfile` is `FROM` and `COPY` only, one target
  per variant on the published base.** `python` is `trixie` as it is;
  `bun` copies Bun onto it, with `node` linked to `bun` (`node
  --version` is not answered) and `npx` a wrapper running `bun x`;
  `go` (Go in `/usr/local/go`) and `rust` copy theirs onto
  `trixie-cc`, Rust's two homes moved to `/opt/home/.rustup` and
  `/opt/home/.cargo` and owned by the sandbox user, since `/usr` is
  read-only under Landlock and HOME is the container's own disk.
  Measured locally (`docker images`, linux/arm64, 2026-11-25): python
  491 MB, bun 652 MB, go 1.22 GB, rust 1.6 GB.
- **The base is pinned by tag and digest in two literal `FROM`
  lines,** `1ctx-shell-base:trixie@sha256:...` and
  `:trixie-cc@sha256:...`, never an `ARG`, so Dependabot's docker
  update bumps the digests in its `images` group. A moved tag changes
  nothing until that pull request merges. An urgent fix: run
  `shell-base.yml` by hand, bump the two digests by hand, release.
- **No `RUN` runs on the target platform.** A command belongs in the
  base Dockerfile. Bun's links and `npx` are made in `bunlinks`, `FROM
  --platform=$BUILDPLATFORM` on the pinned `oven/bun`, and copied in,
  the links staying links. So one runner builds both platforms with no
  emulation, and an added `RUN` fails the arm64 build in CI, which has
  no QEMU. A test checks it.
- **The variants Dockerfile pins every image it takes from by digest
  and downloads nothing:** the base, and the official `oven/bun`,
  `golang` and `rust` slim images. `oven/bun` is the root Dockerfile's
  and `rust` the base's ripgrep build's, the same tag and digest, so
  each pair moves together (a test checks Rust's). Dependabot bumps
  every digest. A new Bun, Go, Python or Rust minor bumps the bash
  description's versions in the same change (`docs/bash.md`), which a
  test checks; Python's is the base Dockerfile's.
- **A change to the base takes two pull requests.** The first changes
  `deploy/sandbox/base/`; its merge publishes the base. The second
  bumps the two digests, with whatever follows in the server (the bash
  description, `docs/bash.md`), so the description never names a tool
  the pinned base lacks.
- **`make sandbox-image` builds every variant locally** as
  `1ctx-shell:dev-<variant>` and the registry name a source run's
  default names, over the pinned base pulled from GHCR (`VARIANT=go`
  builds one). `BASE=local` first builds the base Dockerfile's `base`
  and `cc`, loaded as `1ctx-shell-base:dev` and `:dev-cc`, and passes
  each as a named build context keyed by the `FROM`'s whole reference,
  tag and digest (`--build-context <ref>=docker-image://<tag>`), to try
  a base change before its pull request.

## The base image

- **`deploy/sandbox/base/Dockerfile` holds every step that runs a
  command:** `base` and `cc`. uv's image is named once, as the
  `trixie` stage, and both `base` and git's build start from it, so
  git links the libraries the base ships. `cc` builds its own copy of
  `base`, so the two share no apt layer. Nothing runs this image: the
  server runs `1ctx-shell`. Measured locally (`docker images`,
  linux/arm64, 2026-11-25): base 491 MB and cc 862 MB, from 489 MB and
  783 MB before the archive and common tools were added and git and
  ripgrep built.
- **`base` is the python variant; `cc` adds gcc, g++, libc6-dev and
  pkg-config.** Every tool of both is listed once, in
  `deploy/sandbox/README.md`, with its version and source; a test
  fails when a package of their apt layers or a pinned tool's version
  is missing there. Perl is named in the apt layer, since Debian's git
  package was what pulled it in beyond perl-base.
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
  on `refs/heads/main`. Any other ref, a pull request or a dispatch
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
  expat (push over dumb http), the optional Rust code, the docs, and
  the programs that serve repositories or send mail (`git-daemon`,
  `git-http-backend`, `git-shell`, `git-imap-send`, `scalar`), 2 MB
  each. Dashed built-ins are skipped and the rest are symlinks, never
  hardlinks, and the binaries are stripped: about 12 MB in all. `base`
  installs the libraries git links by name (`libcurl4t64`,
  `libpcre2-8-0`, `libssl3t64`, `zlib1g`), never through curl's
  dependencies.
- **ripgrep builds on the variants Dockerfile's `rust` image,** the
  same tag and digest, so Dependabot moves both. `cargo build
  --release --locked --features pcre2` checks every dependency against
  the crate's lock file, and `PCRE2_SYS_STATIC=1` links PCRE2 in, so
  `rg` needs only libc and libgcc_s.
- **`make sandbox-tools` moves the pins** to the newest stable
  releases: git's highest `X.Y.Z` tarball in kernel.org's
  `sha256sums.asc`, sorted by version, never a release candidate;
  ripgrep's newest stable crate on crates.io. git's sha256 is computed
  from the downloaded tarball and must equal its entry in that list,
  else nothing changes; ripgrep's is the one crates.io lists. It asks
  GitHub nothing, so a runner's shared rate limit never fails it. It
  rewrites only the four lines, never moves a pin back, and changes
  nothing when the pins are current. `--diff` prints what moved against `HEAD`, as
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
  --pcre2`), never by version, so a version bump never fails a variant
  still built on an older base. A tool the base adds is checked by
  running it, and archives, `perl -MJSON::PP` (outside perl-base) and
  `lua` by use.
