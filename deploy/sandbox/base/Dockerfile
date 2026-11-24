# syntax=docker/dockerfile:1
# check=error=true

# The base of the 1ctx shell images, every step that runs a command:
#
# base:  Python and uv, bash, coreutils, findutils, procps, tar, curl,
#        git, make, jq, yq, ripgrep, pdftotext (the python variant)
# cc:    the base and gcc, for cgo and Rust's linker

# jq and yq come from their official images, pinned by digest, so
# Dependabot bumps them. They are static binaries, so they run on any
# base.
FROM ghcr.io/jqlang/jq:1.8.2@sha256:b9c68867e5766576263a222e91db3de422d802069c7af70440e667a95344e486 AS jqdist
FROM mikefarah/yq:4.54.3@sha256:7834187596ad56fd5a81436114e0b0b9dd54c91bb43946d1f7145b2be5f9c3d2 AS yqdist

FROM ghcr.io/astral-sh/uv:python3.15-trixie-slim@sha256:980d6aa868431fd4ef2b32481e934ef5ee3b662c5decade3aa2d7e7ffb8075e4 AS base

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl findutils git make \
      poppler-utils procps ripgrep tar \
 && rm -rf /var/lib/apt/lists/*

COPY --from=jqdist /jq /usr/local/bin/jq
COPY --from=yqdist /usr/bin/yq /usr/local/bin/yq

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

# Only docker run sees these; the server sends its own with each exec,
# the same for every variant.
ENV HOME=/sandbox \
    TMPDIR=/sandbox/tmp \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:/opt/home/go/bin:/opt/home/.cargo/bin:/opt/home/.local/bin:/opt/home/.bun/bin \
    UV_CACHE_DIR=/opt/home/.cache/uv \
    UV_LINK_MODE=copy \
    UV_TOOL_BIN_DIR=/opt/home/.local/bin \
    BUN_INSTALL=/opt/home/.bun \
    BUN_INSTALL_CACHE_DIR=/opt/home/.bun/install/cache \
    GOPATH=/opt/home/go \
    GOCACHE=/opt/home/go/cache \
    GOMODCACHE=/opt/home/go/pkg/mod \
    CGO_ENABLED=1 \
    CC=gcc \
    CARGO_HOME=/opt/home/.cargo \
    RUSTUP_HOME=/opt/home/.rustup \
    DO_NOT_TRACK=1

USER sandbox
WORKDIR /sandbox
CMD ["/bin/bash"]

# gcc for cgo and Rust's linker, one layer go and rust share
FROM base AS cc
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
USER sandbox
