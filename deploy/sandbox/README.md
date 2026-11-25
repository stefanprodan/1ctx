# 1ctx sandbox shell images

When the sandbox shell is on, 1ctx runs each chat's bash commands in an
[OpenShell](https://github.com/NVIDIA/OpenShell) sandbox, a container
started from one of these images. The server picks the image by the
variant an admin chose for the instance or the project (`python`, `bun`,
`go` or `rust`), at the version of the release it runs, unless the admin
saved a custom image instead.

## Images and tags

Every image is built for `linux/amd64` and `linux/arm64` with no
emulation and pushed as one index: the base on a runner of each
architecture, the variants by copying files onto it.

| Image | Tags | Built by | When |
|---|---|---|---|
| `ghcr.io/stefanprodan/1ctx-shell-base` | `trixie`, `trixie-YYYYMMDD` | `.github/workflows/shell-base.yml`, from `base/Dockerfile`, target `base` | every Monday, by hand, and on a merge that changes `base/` |
| `ghcr.io/stefanprodan/1ctx-shell-base` | `trixie-cc`, `trixie-cc-YYYYMMDD` | the same workflow, target `cc` | the same |
| `ghcr.io/stefanprodan/1ctx-shell` | `<version>-<variant>`, `<variant>` | `.github/workflows/release.yml`, from `Dockerfile`, one target per variant | at each release tag |

- The base is what every variant starts from. `trixie` and `trixie-cc`
  move at each build; the dated tags never move, so a past release can
  be rebuilt from the base it used. Nothing runs the base directly.
- The variants, `python`, `bun`, `go` and `rust`, build on the base by
  digest. `<version>-<variant>` (for example `v0.0.8-go`) is the only
  tag the server runs, so its environment and the image's layout always
  match. `<variant>` moves to the newest release and is never pushed
  for a prerelease; use it only to try an image by hand.
- A new base reaches the variants only through a pull request that
  bumps the two digests in `Dockerfile`, so a moved `trixie` tag changes
  no release until that pull request merges.
- Two releases built from the same `Dockerfile` push the same layers,
  so a host that already has one pulls only the new manifest.

## Verifying an image

Every image carries a build provenance attestation from GitHub. Check
it with the GitHub CLI:

```sh
gh attestation verify oci://ghcr.io/stefanprodan/1ctx-shell-base:trixie --owner stefanprodan
gh attestation verify oci://ghcr.io/stefanprodan/1ctx-shell:v0.0.8-go --owner stefanprodan
```

The base's BuildKit provenance is also signed with cosign by Docker's
reusable build workflow, one signature for each platform's provenance
manifest. List those manifests and verify each:

```sh
docker buildx imagetools inspect --raw ghcr.io/stefanprodan/1ctx-shell-base:trixie \
  | jq -r '.manifests[] | select(.annotations["vnd.docker.reference.type"] == "attestation-manifest") | .digest'

cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/docker/github-builder/.github/workflows/build.yml.*$' \
  ghcr.io/stefanprodan/1ctx-shell-base@<digest>
```

## Tools by image

Where a tool comes from:

- **pinned**: built from source at a version and sha256 checksum named
  in `base/Dockerfile`.
- **image**: copied from the project's official image, pinned by tag
  and digest.
- **Debian**: a Debian trixie package, at the version Debian ships on
  the day the base is built.

### `trixie` (the base, and the `python` variant)

| Tool | Version | From |
|---|---|---|
| Debian | trixie | uv's image, `ghcr.io/astral-sh/uv:python3.15-trixie-slim` |
| Python | 3.15 | uv's image |
| uv, uvx | the one in uv's image | uv's image |
| git | 2.56.1 | pinned, kernel.org's tarball, with https and `git grep -P` |
| ripgrep (`rg`) | 16.0.0 | pinned, crates.io's crate, with PCRE2 (`rg --pcre2`) |
| jq | 1.8.2 | image, `ghcr.io/jqlang/jq` |
| yq | 4.54.3 | image, `mikefarah/yq` |

The Debian packages, all from Debian:

| Package | What it gives |
|---|---|
| `bash` | the shell every command runs in |
| `bc` | `bc` |
| `bsdextrautils` | `column`, `hexdump` |
| `bzip2` | `bzip2`, `.tar.bz2` archives |
| `ca-certificates` | the CA bundle for https |
| `coreutils` | the basic file, text and shell commands |
| `curl` | `curl` |
| `file` | `file` |
| `findutils` | `find`, `xargs` |
| `gettext-base` | `envsubst` |
| `less` | `less` |
| `lua5.4` | Lua 5.4, as `lua` |
| `make` | `make` |
| `patch` | `patch` |
| `perl` | Perl with its full standard library |
| `poppler-utils` | `pdftotext` and the other PDF tools |
| `procps` | `ps`, `top`, `kill` |
| `rsync` | `rsync` |
| `sqlite3` | the `sqlite3` shell |
| `tar` | `tar` |
| `tree` | `tree` |
| `unzip` | `unzip` |
| `wget` | `wget` |
| `xz-utils` | `xz`, `.tar.xz` archives |
| `zip` | `zip` |
| `zstd` | `zstd`, `.tar.zst` archives |
| `libcurl4t64`, `libssl3t64`, `libpcre2-8-0`, `zlib1g` | the libraries git links |

### `trixie-cc` (the base of `go` and `rust`)

The base, plus:

| Package | What it gives |
|---|---|
| `gcc` | the C compiler, for cgo and Rust's linker |
| `g++` | the C++ compiler, for native builds |
| `libc6-dev` | the C library's headers |
| `pkg-config` | finds a library's build flags |

### `bun`

`trixie`, plus:

| Tool | Version | From |
|---|---|---|
| Bun | 1.4.4 | image, `oven/bun` |
| `bunx`, `node` | Bun's | links to `bun`, so npm CLIs and `#!/usr/bin/env node` scripts run on Bun |
| `npx` | Bun's | a wrapper running `bun x` |

### `go`

`trixie-cc`, plus:

| Tool | Version | From |
|---|---|---|
| Go | 1.27.4 | image, `golang`, in `/usr/local/go`, with cgo on |

### `rust`

`trixie-cc`, plus:

| Tool | Version | From |
|---|---|---|
| Rust | 1.100.0 | image, `rust` (slim), with `cargo` and `rustup`, the minimal profile |

The toolchain lives in `/opt/home/.rustup` and `/opt/home/.cargo`,
owned by the sandbox user, so `rustup` can add a target or another
toolchain in a running sandbox.

## A custom image

An admin can save any image in place of the variants. 1ctx then runs
it as saved, and bash's description tells the agent only that Python 3
and uv are there and to look for the rest with `command -v`. For 1ctx
to run commands in it, the image must have:

- `/usr/bin/bash` and `/usr/local/bin/python3` (Python 3): the server
  runs its helpers with these exact paths.
- `/usr/bin/sleep`: each sandbox's keep-alive is `/usr/bin/sleep
  infinity`.
- `uv` on the `PATH` below, since bash's description tells the agent
  to install packages with it.
- These folders, each a real folder and not a link, writable by the
  user the image runs as: `/knowledge`, `/uploads`, `/mcp`, `/tmp`,
  `/opt/home`, `/sandbox/tmp` and `/sandbox/.1ctx`. And `/repos`, a
  folder. 1ctx checks every one in the image's first sandbox and
  refuses the image when one is missing or not writable, since
  Landlock skips a path that does not exist.
- A home folder and working folder that are not `/opt/home`. OpenShell
  keeps the image's home and working folder for its workspace and
  fails a sandbox that mounts there; the 1ctx images use `/sandbox`.

Every command runs with the server's environment, never the image's
`ENV`: `HOME=/opt/home`, `TMPDIR=/sandbox/tmp` and `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:/opt/home/go/bin:/opt/home/.cargo/bin:/opt/home/.local/bin:/opt/home/.bun/bin`,
plus uv's, Bun's, Go's and Rust's settings pointing into `/opt/home`.
`/usr`, `/bin`, `/lib` and `/etc` are read-only in a sandbox, so what a
command installs goes into `/opt/home`. The 1ctx images run as the
user `sandbox` (uid and gid 1000), which owns every writable folder.

## Building and checking locally

From the repository root:

```sh
make sandbox-image                  # every variant, native, as 1ctx-shell:dev-<variant>
make sandbox-image VARIANT=go       # one variant
make sandbox-image BASE=local       # on base/Dockerfile built here, not the pinned base
make sandbox-image PLATFORMS=linux/amd64,linux/arm64  # both platforms, build cache only
```

`make sandbox-image` pulls the base the `Dockerfile` pins. `BASE=local`
first builds `base/Dockerfile`'s `base` and `cc`, loaded as
`1ctx-shell-base:dev` and `1ctx-shell-base:dev-cc`, and builds the
variants on them, to try a change to the base before its pull request.

Each variant's promise is a contract in `checks/`. Run its offline half
in `docker run`, with the network off and as the image's own user:

```sh
make sandbox-image-check ARGS="--docker --variant go"
make sandbox-image-check ARGS="--docker --variant cc --image 1ctx-shell-base:dev-cc"
```

Without `--docker` the contract runs through a real OpenShell gateway,
the local preview's by default, offline and then online.

`make sandbox-tools` moves the git and ripgrep pins in
`base/Dockerfile` to their newest stable releases, checking each
checksum against the project's own list.
