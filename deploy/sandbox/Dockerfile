# syntax=docker/dockerfile:1
# check=error=true

# The 1ctx shell image
#
# Runtimes:  Python, Bun
# Packages:  uv, npm (via bun)
# Data:      jq, yq, ripgrep
# System:    bash, coreutils, findutils, procps, tar, curl, git
FROM ghcr.io/astral-sh/uv:python3.15-trixie-slim@sha256:980d6aa868431fd4ef2b32481e934ef5ee3b662c5decade3aa2d7e7ffb8075e4

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

# Landlock skips a path that does not exist, so every root the policy
# names is made here. OpenShell refuses a mount on the image's home, so
# the home is /sandbox and the server's HOME is /opt/home.
RUN groupadd -g 1000 sandbox \
 && useradd -u 1000 -g 1000 -d /sandbox -s /bin/bash sandbox \
 && mkdir -p /knowledge /uploads /mcp /repos \
      /opt/home /sandbox/tmp /sandbox/.1ctx \
 && chown sandbox:sandbox /knowledge /uploads /mcp \
      /sandbox /opt/home /sandbox/tmp /sandbox/.1ctx \
 && chmod 1777 /tmp

# Only docker run sees these; the server sends its own with each exec.
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
CMD ["/bin/bash"]
