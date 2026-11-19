# syntax=docker/dockerfile:1
# check=error=true

# The image a sandbox shell runs. It holds the tools a command reaches
# for and every root the sandbox policy names: Landlock skips a path
# that does not exist. The fixed helpers are not here; the server passes
# them with each exec, so the image never drifts from the binary.
# The base brings Python and uv, both in /usr/local/bin.
FROM ghcr.io/astral-sh/uv:python3.15-trixie-slim@sha256:980d6aa868431fd4ef2b32481e934ef5ee3b662c5decade3aa2d7e7ffb8075e4

# yq and bun are release binaries, pinned with the sha256 each release
# publishes for it; bun is the root Dockerfile's version
ARG YQ_VERSION=v4.54.3
ARG YQ_SHA256_AMD64=129534601871538efe0ba4c5e62a34fb1d5f469bcb975c4fddeb467d82974973
ARG YQ_SHA256_ARM64=89f69310b61b68d1245065a1241d1fc843f7a36cd6103ffd77ad987613bd1b67
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256_AMD64=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG BUN_SHA256_ARM64=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl findutils git jq procps \
      ripgrep tar \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) bun=bun-linux-x64; yq_sha=$YQ_SHA256_AMD64; \
        bun_sha=$BUN_SHA256_AMD64 ;; \
      arm64) bun=bun-linux-aarch64; yq_sha=$YQ_SHA256_ARM64; \
        bun_sha=$BUN_SHA256_ARM64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /usr/local/bin/yq \
      "https://github.com/mikefarah/yq/releases/download/$YQ_VERSION/yq_linux_$TARGETARCH"; \
    echo "$yq_sha  /usr/local/bin/yq" | sha256sum -c -; \
    curl -fsSLo /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$bun.zip"; \
    echo "$bun_sha  /tmp/bun.zip" | sha256sum -c -; \
    python3 -m zipfile -e /tmp/bun.zip /tmp/bun; \
    mv "/tmp/bun/$bun/bun" /usr/local/bin/bun; \
    ln -s bun /usr/local/bin/bunx; \
    chmod 0755 /usr/local/bin/yq /usr/local/bin/bun; \
    rm -r /tmp/bun.zip /tmp/bun

# uid 1000 is the workload's.
# /knowledge, /uploads and /mcp hold rows the server pushes as the
# workload, and /sandbox/.1ctx a command's records; /repos takes
# read-only mounts. /tmp, /opt/home and /sandbox/tmp are the sandbox's
# own files on the container's disk, never saved. OpenShell keeps the
# image's home and working folder for its workspace and refuses a mount
# there, so both are /sandbox, its workspace, and the server's HOME,
# /opt/home, which it sets on each exec, is never either.
RUN groupadd -g 1000 sandbox \
 && useradd -u 1000 -g 1000 -d /sandbox -s /bin/bash sandbox \
 && mkdir -p /knowledge /uploads /mcp /repos \
      /opt/home /sandbox/tmp /sandbox/.1ctx \
 && chown sandbox:sandbox /knowledge /uploads /mcp \
      /sandbox /opt/home /sandbox/tmp /sandbox/.1ctx \
 && chmod 1777 /tmp

# For docker run only: OpenShell's execs do not see these, so the
# server passes its own. uv keeps its cache and tools in the home, not
# the base's /usr/local/bin, and copies, since the cache and a project
# may sit on different mounts. bun keeps its cache and global packages in
# the home too, never /knowledge, and sends no crash reports
ENV HOME=/sandbox \
    TMPDIR=/sandbox/tmp \
    UV_CACHE_DIR=/opt/home/.cache/uv \
    UV_LINK_MODE=copy \
    UV_TOOL_BIN_DIR=/opt/home/.local/bin \
    BUN_INSTALL=/opt/home/.bun \
    BUN_INSTALL_CACHE_DIR=/opt/home/.bun/install/cache \
    DO_NOT_TRACK=1

USER sandbox
WORKDIR /sandbox
# the base runs uv; a plain run gets a shell, as before
CMD ["/bin/bash"]
